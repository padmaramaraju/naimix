import "dotenv/config";
import path from "node:path";
import { EndpointRegistry } from "./endpointRegistry";
import { GatewaysRegistry } from "./gatewaysRegistry";
import { AuthProvidersRegistry } from "./authProvidersRegistry";
import { closeAllSqlConnections } from "../connectors";
import { createDataPlaneApp } from "./dataPlaneApp";
import { logger } from "./logger";
import { resolveConfigDir } from "./workspaceSettings";

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
 * Config resolution is deliberately simpler than index.ts's (the
 * development entry point): no SETTINGS_FILE / "persisted workspace"
 * support, because that's the admin console's own "Change workspace"
 * feature remembering a developer's choice across restarts of their own
 * local instance -- meaningless (and absent on purpose) here. A QA/
 * Production instance reads from wherever CONFIG_DIR (or the legacy
 * ENDPOINTS_DIR/GATEWAYS_FILE/AUTH_PROVIDERS_FILE trio) points it at
 * startup -- typically the shared network volume the promotion pipeline
 * populates (see DEPLOYMENT_ARCHITECTURE_NOTES.md) -- and that's the only
 * place it will ever read from until the process is restarted with a
 * different value. There is no in-process way to change it, matching "QA
 * and Production instances have no local Git checkout at all" from that
 * same document.
 */

export type DataPlaneEnvironment = "qa" | "prod";

const PORT = Number(process.env.PORT ?? 4000);

function resolveStartupPaths(): { endpointsDir: string; gatewaysFile: string; authProvidersFile: string; configDir?: string } {
  if (process.env.CONFIG_DIR) {
    const configDir = path.resolve(process.cwd(), process.env.CONFIG_DIR);
    return { ...resolveConfigDir(configDir), configDir };
  }
  return {
    endpointsDir: path.resolve(process.cwd(), process.env.ENDPOINTS_DIR ?? "config/endpoints"),
    gatewaysFile: path.resolve(process.cwd(), process.env.GATEWAYS_FILE ?? "config/gateways.yaml"),
    authProvidersFile: path.resolve(process.cwd(), process.env.AUTH_PROVIDERS_FILE ?? "config/authProviders.yaml"),
  };
}

export function startDataPlaneServer(environment: DataPlaneEnvironment): void {
  const label = environment === "prod" ? "Production" : "QA";
  const { endpointsDir, gatewaysFile, authProvidersFile, configDir } = resolveStartupPaths();

  const endpointRegistry = new EndpointRegistry(endpointsDir);
  const gatewaysRegistry = new GatewaysRegistry(gatewaysFile);
  const authProvidersRegistry = new AuthProvidersRegistry(authProvidersFile);

  const { errors } = endpointRegistry.reloadFromDisk();
  for (const e of errors) {
    logger.error(`Failed to load endpoint config ${e.file}: ${e.error}`);
  }
  if (endpointRegistry.list().length === 0) {
    logger.warn("No valid endpoint configs were loaded. The server will start with no endpoints.");
  }

  const app = createDataPlaneApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger });

  const server = app.listen(PORT, () => {
    logger.info(`Naimix (${label} data-plane) listening on http://localhost:${PORT}`);
    logger.info(`Loaded ${endpointRegistry.list().length} endpoint(s) from ${endpointsDir}`);
    if (configDir) {
      logger.info(`Workspace: ${configDir}`);
    }
    logger.info(`GET /__endpoints for a live list, GET /healthz for status`);
    logger.info("Admin console is not present in this build -- see DEPLOYMENT_ARCHITECTURE_NOTES.md.");
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
