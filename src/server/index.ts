import "dotenv/config";
import path from "node:path";
import { EndpointRegistry } from "./endpointRegistry";
import { GatewaysRegistry } from "./gatewaysRegistry";
import { closeAllSqlConnections } from "../connectors";
import { createApp } from "./app";
import { logger } from "./logger";
import { loadWorkspaceSettings, resolveConfigDir } from "./workspaceSettings";

const PORT = Number(process.env.PORT ?? 4000);
const ADMIN_UI_DIR = path.resolve(process.cwd(), "public/admin");
const SETTINGS_FILE = path.resolve(process.cwd(), process.env.SETTINGS_FILE ?? "data/settings.json");

/**
 * Resolves where endpoints/gateways load from at startup, in priority
 * order:
 *  1. A workspace the admin UI previously saved via "Change workspace"
 *     (persisted in SETTINGS_FILE -- see workspaceSettings.ts). This is
 *     what makes the choice survive a restart, which is the whole point of
 *     each user running their own instance against their own Git checkout.
 *     The persisted value is resolved against process.cwd() -- the admin
 *     UI always saves an absolute path (see adminApi.ts's PUT handler), but
 *     a relative one (e.g. hand-set to "config" to point at this project's
 *     own bundled config/ folder, keeping the whole checkout self-contained
 *     and portable) resolves correctly too rather than only working by
 *     accident of whatever path.join happens to produce.
 *  2. CONFIG_DIR env var, if set -- same "one folder holds both endpoints/
 *     and gateways.yaml" convention, useful for scripting/CI or a first run
 *     before anyone's used the admin UI.
 *  3. Legacy ENDPOINTS_DIR/GATEWAYS_FILE env vars, independently (each
 *     defaulting to the project's own config/endpoints and
 *     config/gateways.yaml) -- unchanged pre-workspace-feature behavior,
 *     kept for anyone who wants endpoints and gateways stored in unrelated
 *     places rather than one shared folder.
 */
function resolveStartupPaths(): { endpointsDir: string; gatewaysFile: string; configDir?: string } {
  const persisted = loadWorkspaceSettings(SETTINGS_FILE);
  if (persisted) {
    const configDir = path.resolve(process.cwd(), persisted.configDir);
    return { ...resolveConfigDir(configDir), configDir };
  }
  if (process.env.CONFIG_DIR) {
    const configDir = path.resolve(process.cwd(), process.env.CONFIG_DIR);
    return { ...resolveConfigDir(configDir), configDir };
  }
  return {
    endpointsDir: path.resolve(process.cwd(), process.env.ENDPOINTS_DIR ?? "config/endpoints"),
    gatewaysFile: path.resolve(process.cwd(), process.env.GATEWAYS_FILE ?? "config/gateways.yaml"),
  };
}

function main() {
  const { endpointsDir, gatewaysFile, configDir } = resolveStartupPaths();
  const workspace: { configDir?: string } = { configDir };

  const endpointRegistry = new EndpointRegistry(endpointsDir);
  const gatewaysRegistry = new GatewaysRegistry(gatewaysFile);

  const { errors } = endpointRegistry.reloadFromDisk();
  for (const e of errors) {
    logger.error(`Failed to load endpoint config ${e.file}: ${e.error}`);
  }
  if (endpointRegistry.list().length === 0) {
    logger.warn("No valid endpoint configs were loaded. The server will start with no endpoints.");
  }

  const app = createApp({
    endpointRegistry,
    gatewaysRegistry,
    logger,
    adminUiDir: ADMIN_UI_DIR,
    workspace,
    settingsFile: SETTINGS_FILE,
  });

  const server = app.listen(PORT, () => {
    logger.info(`Naimix listening on http://localhost:${PORT}`);
    logger.info(`Loaded ${endpointRegistry.list().length} endpoint(s) from ${endpointsDir}`);
    if (configDir) {
      logger.info(`Workspace: ${configDir}`);
    }
    logger.info(`GET /__endpoints for a live list, GET /healthz for status`);
    if (process.env.ADMIN_TOKEN) {
      logger.info(`Admin UI: http://localhost:${PORT}/admin`);
    } else {
      logger.warn("ADMIN_TOKEN is not set -- the admin UI/API is disabled. Set it in .env to enable it.");
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
