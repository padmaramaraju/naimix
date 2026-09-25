import path from "node:path";
import type { Express } from "express";
import express from "express";
import { createBaseApp, mountDataPlaneRoutes, mountTerminalHandlers } from "./coreApp";
import { createAdminApiRouter } from "./adminApi";
import { requireAdminAuth } from "./adminAuth";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { Logger } from "./logger";

/**
 * The FULL app: admin console (UI + API) mounted alongside the data plane,
 * in one process. This is deliberately a development-only composition --
 * see DEPLOYMENT_ARCHITECTURE_NOTES.md's "Installation: how development
 * differs from QA/Production". QA and Production run dataPlaneApp.ts's
 * createDataPlaneApp() instead, via the separate src/server/qaIndex.ts and
 * src/server/prodIndex.ts entry points (two build targets, kept separate
 * so QA/Production behavior can diverge later without touching each
 * other -- see dataPlaneServer.ts) -- neither imports this file,
 * adminApi.ts, or adminAuth.ts at all, so the admin console is
 * structurally absent from either artifact rather than merely disabled by
 * config. See dataPlaneApp.ts's own comment for the other half of that
 * split.
 */

export interface CreateAppOptions {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  logger: Logger;
  /** Directory containing the admin UI's static files (index.html, etc). */
  adminUiDir?: string;
  /** Mutable "current workspace" holder + where to persist a change to it
   * -- see workspaceSettings.ts. Both optional: when omitted, the admin
   * UI's "Change workspace" feature is unavailable (GET/PUT /settings
   * aren't mounted), which is fine for callers (e.g. some tests) that
   * don't need it -- everything else about the app works unchanged. */
  workspace?: { configDir?: string };
  settingsFile?: string;
}

export function createApp({
  endpointRegistry,
  gatewaysRegistry,
  authProvidersRegistry,
  logger,
  adminUiDir,
  workspace,
  settingsFile,
}: CreateAppOptions): Express {
  const { app, authService } = createBaseApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger });

  // Admin UI: a static browser app (served publicly) talking to a
  // token-gated API. The UI itself has no secrets in it; every API call it
  // makes carries the bearer token entered on the page. Mounted between the
  // base app (healthz/__endpoints) and the data-plane routes below,
  // matching this app's original route order exactly.
  if (adminUiDir) {
    // express.static 301-redirects a bare "/admin" to "/admin/" itself (so
    // the page's relative asset URLs resolve), then serves index.html for it.
    app.use("/admin", express.static(adminUiDir));
  }
  app.use(
    "/admin/api",
    requireAdminAuth,
    createAdminApiRouter({
      endpointRegistry,
      gatewaysRegistry,
      authProvidersRegistry,
      authService,
      logger,
      workspace: workspace ?? {},
      settingsFile: settingsFile ?? path.resolve(process.cwd(), "data/settings.json"),
    })
  );

  // Caller-facing login/logout + the dynamic dispatcher -- see
  // coreApp.ts's mountDataPlaneRoutes(). Mounted after admin, matching this
  // app's original route order exactly (though see mountDataPlaneRoutes()'s
  // own comment on why the order among these particular routes doesn't
  // actually matter: dispatch.ts's middleware calls next() for anything it
  // doesn't recognize as a configured endpoint path).
  mountDataPlaneRoutes(app, { endpointRegistry, gatewaysRegistry, authService, logger });
  mountTerminalHandlers(app, logger);

  return app;
}
