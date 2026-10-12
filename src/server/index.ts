import "dotenv/config";
import path from "node:path";
import { IntegrationRegistry } from "./integrationRegistry";
import { AppRegistry } from "./appRegistry";
import { MountedRouteRegistry } from "./mountedRouteRegistry";
import { GatewaysRegistry } from "./gatewaysRegistry";
import { AuthProvidersRegistry } from "./authProvidersRegistry";
import { FunctionRegistry } from "../transform/functionRegistry";
import { closeAllSqlConnections } from "../connectors";
import { createApp } from "./app";
import { logger } from "./logger";
import { loadDeploymentConfig, resolveConfigDir } from "./deploymentConfig";
import type { DeploymentMount } from "../types/config";

const PORT = Number(process.env.PORT ?? 4000);
const CONSOLE_UI_DIR = path.resolve(process.cwd(), "public/console");
const DEPLOYMENT_FILE = path.resolve(process.cwd(), process.env.DEPLOYMENT_FILE ?? "deployment.yaml");

/**
 * Resolves where Integrations/Apps/gateways load from at startup, in
 * priority order:
 *  1. A workspace the console UI previously saved via "Change workspace"
 *     (persisted in DEPLOYMENT_FILE's `configDir` -- see
 *     deploymentConfig.ts's saveDeploymentConfigDir). This is what makes
 *     the choice survive a restart, which is the whole point of each user
 *     running their own instance against their own Git checkout. The
 *     persisted value is resolved against process.cwd() -- the console UI
 *     always saves an absolute path (see consoleApi.ts's PUT handler), but
 *     a relative one (e.g. hand-set to "config" to point at this project's
 *     own bundled config/ folder, keeping the whole checkout self-contained
 *     and portable) resolves correctly too rather than only working by
 *     accident of whatever path.join happens to produce.
 *  2. CONFIG_DIR env var, if set -- same "one folder holds integrations/,
 *     apps/, and gateways.yaml" convention, useful for scripting/CI or a
 *     first run before anyone's used the console UI.
 *  3. Legacy INTEGRATIONS_DIR/APPS_DIR/GATEWAYS_FILE/AUTH_PROVIDERS_FILE/
 *     TRANSFORMS_DIR env vars, independently (each defaulting to the
 *     project's own config/integrations, config/apps, etc.) -- unchanged
 *     pre-workspace-feature-style behavior, kept for anyone who wants these
 *     stored in unrelated places rather than one shared folder.
 *
 * `mounts` (which Apps are actually exposed, and under what basePath) is
 * independent of all three of the above -- it only ever comes from
 * DEPLOYMENT_FILE's own `mounts` list (see WORKSPACE_APPS_DESIGN_NOTES.md:
 * combining configDir and the deploy-apps list into one hand-edited YAML
 * was the whole point of deployment.yaml replacing settings.json). A
 * missing DEPLOYMENT_FILE -- e.g. a fresh checkout that hasn't hand-created
 * one yet from deployment.yaml.example -- means zero mounted routes even
 * if integrations/apps exist on disk; that's intentional, not a bug.
 */
function resolveStartupPaths(): {
  integrationsDir: string;
  appsDir: string;
  gatewaysFile: string;
  authProvidersFile: string;
  transformsDir: string;
  configDir?: string;
  mounts: DeploymentMount[];
} {
  const deployment = loadDeploymentConfig(DEPLOYMENT_FILE);
  const mounts = deployment?.mounts ?? [];

  if (deployment?.configDir) {
    const configDir = path.resolve(process.cwd(), deployment.configDir);
    return { ...resolveConfigDir(configDir), configDir, mounts };
  }
  if (process.env.CONFIG_DIR) {
    const configDir = path.resolve(process.cwd(), process.env.CONFIG_DIR);
    return { ...resolveConfigDir(configDir), configDir, mounts };
  }
  return {
    integrationsDir: path.resolve(process.cwd(), process.env.INTEGRATIONS_DIR ?? "config/integrations"),
    appsDir: path.resolve(process.cwd(), process.env.APPS_DIR ?? "config/apps"),
    gatewaysFile: path.resolve(process.cwd(), process.env.GATEWAYS_FILE ?? "config/gateways.yaml"),
    authProvidersFile: path.resolve(process.cwd(), process.env.AUTH_PROVIDERS_FILE ?? "config/authProviders.yaml"),
    transformsDir: path.resolve(process.cwd(), process.env.TRANSFORMS_DIR ?? "config/transforms"),
    mounts,
  };
}

function main() {
  const { integrationsDir, appsDir, gatewaysFile, authProvidersFile, transformsDir, configDir, mounts } =
    resolveStartupPaths();
  const workspace: { configDir?: string } = { configDir };

  // Loaded before the integration registry so a config's `transform`/
  // `postProcess` function-name references can be validated against it
  // (see integrationRegistry.ts). Unlike QA/Production, the Developer
  // Console also calls functionRegistry.reloadOne() later, after saving an
  // edited function (see consoleApi.ts) -- this initial load is just the
  // normal "read what's on disk at boot" step every other registry does too.
  const functionRegistry = new FunctionRegistry(transformsDir);
  const { errors: functionErrors } = functionRegistry.loadFromDisk();
  for (const e of functionErrors) {
    logger.error(`Failed to load transform function ${e.file}: ${e.error}`);
  }

  const integrationRegistry = new IntegrationRegistry(integrationsDir, functionRegistry);
  // appRegistry is given integrationRegistry so it can validate each
  // route's `integration` reference -- load order matters: integrations
  // must be loaded first (right below) so those references resolve.
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

  // Synthesized from deployment.yaml's `mounts` + appRegistry/
  // integrationRegistry above -- see mountedRouteRegistry.ts. Its errors()
  // surfaces a mount referencing an unknown app, or a route referencing an
  // unknown integration, loudly at boot -- same "bad reference is a load
  // error" convention as the errors logged above.
  const routeRegistry = new MountedRouteRegistry(mounts, appRegistry, integrationRegistry);
  for (const e of routeRegistry.errors()) {
    logger.error(`Mounted route error: ${e}`);
  }

  const app = createApp({
    routeRegistry,
    integrationRegistry,
    appRegistry,
    gatewaysRegistry,
    authProvidersRegistry,
    functionRegistry,
    logger,
    consoleUiDir: CONSOLE_UI_DIR,
    workspace,
    deploymentFile: DEPLOYMENT_FILE,
  });

  const server = app.listen(PORT, () => {
    logger.info(`Naimix listening on http://localhost:${PORT}`);
    logger.info(
      `Loaded ${integrationRegistry.list().length} integration(s) from ${integrationsDir}, ` +
        `${appRegistry.list().length} app(s) from ${appsDir} ` +
        `(${routeRegistry.list().length} route(s) mounted)`
    );
    if (configDir) {
      logger.info(`Workspace: ${configDir}`);
    }
    logger.info(`GET /__endpoints for a live list, GET /healthz for status`);
    if (process.env.CONSOLE_TOKEN) {
      logger.info(`Console UI: http://localhost:${PORT}/console`);
    } else {
      logger.warn("CONSOLE_TOKEN is not set -- the console UI/API is disabled. Set it in .env to enable it.");
    }
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

main();
