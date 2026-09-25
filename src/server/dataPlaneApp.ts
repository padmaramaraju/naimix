import type { Express } from "express";
import { createBaseApp, mountDataPlaneRoutes, mountTerminalHandlers } from "./coreApp";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { Logger } from "./logger";

/**
 * The QA/Production app: everything a caller/API-consumer needs
 * (/healthz, /__endpoints, /auth login+logout, and every configured
 * endpoint via the dynamic dispatcher) and nothing an admin needs. This
 * file deliberately does NOT import adminApi.ts or adminAuth.ts -- not
 * "doesn't call them," but never references them at all, anywhere in its
 * module graph. That's the whole point: see DEPLOYMENT_ARCHITECTURE_NOTES.md's
 * "Installation: how development differs from QA/Production", which calls
 * for the admin console to be structurally absent from the QA/Production
 * artifact, not merely disabled by an unset ADMIN_TOKEN the way app.ts's
 * full/dev composition is.
 *
 * Only src/server/dataPlaneServer.ts's startDataPlaneServer() calls this --
 * shared logic that src/server/qaIndex.ts and src/server/prodIndex.ts (the
 * QA and Production entry points, respectively) each call in turn. They're
 * kept as two separate entry files/build targets, even though they run
 * identical code today, specifically so QA-only or Production-only
 * behavior has an obvious place to land later without touching the other
 * -- see dataPlaneServer.ts's own comment. The ordinary development entry
 * point, src/server/index.ts, calls app.ts's createApp() instead, which
 * layers the admin UI/API on top of the exact same coreApp.ts building
 * blocks this function uses. A change to a data-plane behavior (the
 * dispatcher, caller auth, health/introspection) made in coreApp.ts
 * automatically applies to every one of these apps, so there's exactly one
 * place to fix a business-logic bug -- see DEPLOYMENT_ARCHITECTURE_NOTES.md's
 * "shared core, two thin entry points" framing.
 *
 * `npm run build:qa`/`npm run build:prod` each bundle their own entry point
 * (via esbuild, see package.json) into their own single-file artifact and
 * then grep that artifact for admin-only identifiers, failing the build if
 * any are found -- a structural check that this separation hasn't quietly
 * regressed, not just a comment asserting it holds. See
 * scripts/checkDataPlaneBundle.js.
 */
export interface CreateDataPlaneAppOptions {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  logger: Logger;
}

export function createDataPlaneApp({
  endpointRegistry,
  gatewaysRegistry,
  authProvidersRegistry,
  logger,
}: CreateDataPlaneAppOptions): Express {
  const { app, authService } = createBaseApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger });
  mountDataPlaneRoutes(app, { endpointRegistry, gatewaysRegistry, authService, logger });
  mountTerminalHandlers(app, logger);
  return app;
}
