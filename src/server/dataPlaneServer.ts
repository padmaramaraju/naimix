import "dotenv/config";
import path from "node:path";
import { IntegrationRegistry } from "./integrationRegistry";
import { AppRegistry } from "./appRegistry";
import { MountedRouteRegistry } from "./mountedRouteRegistry";
import { GatewaysRegistry } from "./gatewaysRegistry";
import { AuthProvidersRegistry } from "./authProvidersRegistry";
import { FunctionRegistry } from "../transform/functionRegistry";
import { closeAllSqlConnections } from "../connectors";
import { createDataPlaneApp } from "./dataPlaneApp";
import { logger } from "./logger";
import { loadDeploymentConfig, resolveConfigDir } from "./deploymentConfig";

/**
 * The shared QA/Production startup logic -- see dataPlaneApp.ts's own
 * comment for why this exists as a separate module from app.ts/index.ts
 * (the development entry point) in the first place. src/server/qaIndex.ts
 * and src/server/prodIndex.ts are both thin wrappers that call
 * startDataPlaneServer() below with "qa"/"prod" and nothing else.
 *
 * QA and Production are deliberately kept as two separate entry
 * files/build targets even though they run identical code today (see
 * package.json's build:qa/start:qa/dev:qa and build:prod/start:prod/
 * dev:prod scripts) -- Padma's own reasoning for asking for this split.
 * The moment QA or Production needs to actually differ (a feature flag, a
 * different default, stricter validation in one but not the other), that
 * change has an obvious, low-friction place to land: edit qaIndex.ts or
 * prodIndex.ts alone, without touching the other or this shared file,
 * rather than threading a new conditional through one shared entry point.
 * Until that day, `environment` below only affects the startup log line.
 *
 * configDir resolution is deliberately simpler than index.ts's (the
 * development entry point): no "persisted workspace" support, because
 * that's the developer console's own "Change workspace" feature
 * remembering a developer's choice across restarts of their own local
 * instance -- meaningless (and absent on purpose) here. A QA/Production
 * instance reads integrations/apps/gateways from wherever CONFIG_DIR (or
 * the legacy INTEGRATIONS_DIR/APPS_DIR/GATEWAYS_FILE/AUTH_PROVIDERS_FILE
 * group) points it at startup -- typically the shared network volume the
 * promotion pipeline populates (see DEPLOYMENT_ARCHITECTURE_NOTES.md) --
 * and that's the only place it will ever read from until the process is
 * restarted with a different value. There is no in-process way to change
 * it, matching "QA and Production instances have no local Git checkout at
 * all" from that same document.
 *
 * `mounts`, unlike configDir, is NOT resolved from CONFIG_DIR/legacy env
 * vars -- it only ever comes from DEPLOYMENT_FILE's own `mounts` list, the
 * exact same per-environment hand-edited deployment.yaml dev uses (see
 * WORKSPACE_APPS_DESIGN_NOTES.md), just without the "persisted via Console
 * UI" write-back dev has (there's no console here to write it): the
 * deployment team places this environment's own deployment.yaml onto it
 * as part of promotion, the same way they'd hand-edit any other
 * per-environment config. A missing or mounts-less DEPLOYMENT_FILE here
 * means zero routes, logged loudly rather than silently -- a QA/Production
 * instance with no routes almost always means someone forgot to drop one.
 */

export type DataPlaneEnvironment = "qa" | "prod";

const PORT = Number(process.env.PORT ?? 4000);
const DEPLOYMENT_FILE = path.resolve(process.cwd(), process.env.DEPLOYMENT_FILE ?? "deployment.yaml");

function resolveStartupPaths(): {
  integrationsDir: string;
  appsDir: string;
  gatewaysFile: string;
  authProvidersFile: string;
  transformsDir: string;
  configDir?: string;
} {
  if (process.env.CONFIG_DIR) {
    const configDir = path.resolve(process.cwd(), process.env.CONFIG_DIR);
    return { ...resolveConfigDir(configDir), configDir };
  }
  return {
    integrationsDir: path.resolve(process.cwd(), process.env.INTEGRATIONS_DIR ?? "config/integrations"),
    appsDir: path.resolve(process.cwd(), process.env.APPS_DIR ?? "config/apps"),
    gatewaysFile: path.resolve(process.cwd(), process.env.GATEWAYS_FILE ?? "config/gateways.yaml"),
    authProvidersFile: path.resolve(process.cwd(), process.env.AUTH_PROVIDERS_FILE ?? "config/authProviders.yaml"),
    transformsDir: path.resolve(process.cwd(), process.env.TRANSFORMS_DIR ?? "config/transforms"),
  };
}

export function startDataPlaneServer(environment: DataPlaneEnvironment): void {
  const label = environment === "prod" ? "Production" : "QA";
  const { integrationsDir, appsDir, gatewaysFile, authProvidersFile, transformsDir, configDir } = resolveStartupPaths();

  // Loaded BEFORE the integration registry, and only ever loaded once here
  // -- see FunctionRegistry's own doc comment for why QA/Production never
  // call reloadOne()/remove() at all. A config referencing a custom
  // transform function needs this registry already populated to validate
  // against (see integrationRegistry.ts's reloadFromDisk()).
  const functionRegistry = new FunctionRegistry(transformsDir);
  const { errors: functionErrors } = functionRegistry.loadFromDisk();
  for (const e of functionErrors) {
    logger.error(`Failed to load transform function ${e.file}: ${e.error}`);
  }

  const integrationRegistry = new IntegrationRegistry(integrationsDir, functionRegistry);
  const appRegistry = new AppRegistry(appsDir, integrationRegistry);
  const gatewaysRegistry = new GatewaysRegistry(gatewaysFile);
  const authProvidersRegistry = new AuthProvidersRegistry(authProvidersFile);

  const { errors: integrationErrors } = integrationRegistry.reloadFromDisk();
  for (const e of integrationErrors) {
    logger.error(`Failed to load integration config ${e.file}: ${e.error}`);
  }
  if (integrationRegistry.list().length === 0) {
    logger.warn("No valid integration configs were loaded.");
  }

  const { errors: appErrors } = appRegistry.reloadFromDisk();
  for (const e of appErrors) {
    logger.error(`Failed to load app config ${e.file}: ${e.error}`);
  }
  if (appRegistry.list().length === 0) {
    logger.warn("No valid app configs were loaded. The server will start with no routes.");
  }

  const deployment = loadDeploymentConfig(DEPLOYMENT_FILE);
  const mounts = deployment?.mounts ?? [];
  if (mounts.length === 0) {
    logger.warn(`No mounts found in ${DEPLOYMENT_FILE} -- the server will start with no routes.`);
  }

  const routeRegistry = new MountedRouteRegistry(mounts, appRegistry, integrationRegistry);
  for (const e of routeRegistry.errors()) {
    logger.error(`Mounted route error: ${e}`);
  }

  const app = createDataPlaneApp({ routeRegistry, gatewaysRegistry, authProvidersRegistry, functionRegistry, logger });

  const server = app.listen(PORT, () => {
    logger.info(`Naimix (${label} data-plane) listening on http://localhost:${PORT}`);
    logger.info(
      `Loaded ${integrationRegistry.list().length} integration(s) from ${integrationsDir}, ` +
        `${appRegistry.list().length} app(s) from ${appsDir} ` +
        `(${routeRegistry.list().length} route(s) mounted from ${DEPLOYMENT_FILE})`
    );
    if (configDir) {
      logger.info(`Workspace: ${configDir}`);
    }
    logger.info(`GET /__endpoints for a live list, GET /healthz for status`);
    logger.info("Developer console is not present in this build -- see DEPLOYMENT_ARCHITECTURE_NOTES.md.");
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    server.close();
    await closeAllSqlConnections();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
