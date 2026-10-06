import path from "node:path";
import type { Express } from "express";
import express from "express";
import { createBaseApp, mountDataPlaneRoutes, mountTerminalHandlers } from "./coreApp";
import { createConsoleApiRouter } from "./consoleApi";
import { requireConsoleAuth } from "./consoleAuth";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { Logger } from "./logger";

/**
 * The FULL app: developer console (UI + API) mounted alongside the data plane,
 * in one process. This is deliberately a development-only composition --
 * see DEPLOYMENT_ARCHITECTURE_NOTES.md's "Installation: how development
 * differs from QA/Production". QA and Production run dataPlaneApp.ts's
 * createDataPlaneApp() instead, via the separate src/server/qaIndex.ts and
 * src/server/prodIndex.ts entry points (two build targets, kept separate
 * so QA/Production behavior can diverge later without touching each
 * other -- see dataPlaneServer.ts) -- neither imports this file,
 * consoleApi.ts, or consoleAuth.ts at all, so the developer console is
 * structurally absent from either artifact rather than merely disabled by
 * config. See dataPlaneApp.ts's own comment for the other half of that
 * split.
 */

export interface CreateAppOptions {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  logger: Logger;
  /** Directory containing the console UI's static files (index.html, etc). */
  consoleUiDir?: string;
  /** Mutable "current workspace" holder + where to persist a change to it
   * -- see workspaceSettings.ts. Both optional: when omitted, the console
   * UI's "Change workspace" feature is unavailable (GET/PUT /settings
   * aren't mounted), which is fine for callers (e.g. some tests) that
   * don't need it -- everything else about the app works unchanged. */
  workspace?: { configDir?: string };
  settingsFile?: string;
  /** Overrides the real native folder-picker dialog behind POST
   * /settings/select-folder -- see consoleApi.ts's ConsoleApiDeps and
   * nativeFolderPicker.ts. Only ever set by tests, so they can exercise
   * that route's own logic without actually popping up a GUI dialog. */
  pickFolder?: (startDir: string) => Promise<string | null>;
}

export function createApp({
  endpointRegistry,
  gatewaysRegistry,
  authProvidersRegistry,
  logger,
  consoleUiDir,
  workspace,
  settingsFile,
  pickFolder,
}: CreateAppOptions): Express {
  const { app, authService } = createBaseApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger });

  // Console UI: a static browser app (served publicly) talking to a
  // token-gated API. The UI itself has no secrets in it; every API call it
  // makes carries the bearer token entered on the page. Mounted between the
  // base app (healthz/__endpoints) and the data-plane routes below,
  // matching this app's original route order exactly.
  if (consoleUiDir) {
    // express.static 301-redirects a bare "/console" to "/console/" itself (so
    // the page's relative asset URLs resolve), then serves index.html for it.
    app.use("/console", express.static(consoleUiDir));
  }
  app.use(
    "/console/api",
    requireConsoleAuth,
    createConsoleApiRouter({
      endpointRegistry,
      gatewaysRegistry,
      authProvidersRegistry,
      authService,
      logger,
      workspace: workspace ?? {},
      settingsFile: settingsFile ?? path.resolve(process.cwd(), "data/settings.json"),
      pickFolder,
    })
  );

  // Caller-facing login/logout + the dynamic dispatcher -- see
  // coreApp.ts's mountDataPlaneRoutes(). Mounted after console, matching this
  // app's original route order exactly (though see mountDataPlaneRoutes()'s
  // own comment on why the order among these particular routes doesn't
  // actually matter: dispatch.ts's middleware calls next() for anything it
  // doesn't recognize as a configured endpoint path).
  mountDataPlaneRoutes(app, { endpointRegistry, gatewaysRegistry, authService, logger });
  mountTerminalHandlers(app, logger);

  return app;
}
