import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { createDynamicDispatcher } from "./dispatch";
import { createAuthRouter } from "./authRoutes";
import { AuthService } from "../auth/authService";
import { InMemorySessionStore } from "../auth/sessionStore";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { Logger } from "./logger";

/**
 * Everything BOTH the full (admin + data-plane, development-only) app and
 * the data-plane-only (QA/Production) app need -- and, just as
 * importantly, nothing else. This module has no knowledge of the admin
 * console at all: it does not import adminApi.ts or adminAuth.ts, and
 * never will. That's not a style preference -- it's what makes the
 * data-plane builds (QA via qaIndex.ts, Production via prodIndex.ts, both
 * through dataPlaneApp.ts/dataPlaneServer.ts) structurally unable to
 * expose the admin API, rather than merely not calling it. See
 * "Installation: how development differs from QA/Production" in
 * DEPLOYMENT_ARCHITECTURE_NOTES.md.
 *
 * app.ts (the full/development app) builds on top of createBaseApp() by
 * mounting the admin UI/API in between mountDataPlaneRoutes() and
 * mountTerminalHandlers() -- see its own comments for why that middle slot
 * is where admin routes have to go. dataPlaneApp.ts calls createBaseApp(),
 * then mountDataPlaneRoutes(), then mountTerminalHandlers(), with nothing
 * in between.
 */

export interface CoreAppDeps {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  logger: Logger;
}

export interface BaseApp {
  app: Express;
  authService: AuthService;
}

/**
 * Express instance + CORS + body parsing + the two always-public
 * introspection endpoints (/healthz, /__endpoints), plus a fresh
 * AuthService wired to an in-memory session store (see sessionStore.ts and
 * AUTH_DESIGN_NOTES.md's "Multi-instance / load balancing" for why a real
 * multi-instance deployment needs a shared store instead). Nothing here
 * requires the caller to have decided yet whether this process is the
 * full/dev app or the data-plane-only one -- that choice is made by what
 * gets mounted next, not by anything in this function.
 */
export function createBaseApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger }: CoreAppDeps): BaseApp {
  const authService = new AuthService(authProvidersRegistry, new InMemorySessionStore());
  const app = express();
  app.use(cors());
  // body-parser's own default (used when no `limit` is given) is a hard
  // 100kb -- too small for a real XML/SOAP payload or a bulk SQL write with
  // many rows, and the cause of a bare "request entity too large" error with
  // no indication of why. Configurable per deployment via env var since
  // there's no one right ceiling for every backend this middleware fronts.
  const MAX_REQUEST_BODY_SIZE = process.env.MAX_REQUEST_BODY_SIZE ?? "10mb";
  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));
  app.use(express.urlencoded({ extended: true, limit: MAX_REQUEST_BODY_SIZE }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", endpointCount: endpointRegistry.list().length });
  });

  // Introspection endpoint: lists every configured endpoint so users can see
  // what's live without reading the YAML files.
  app.get("/__endpoints", (_req, res) => {
    res.json(
      endpointRegistry.list().map((r) => ({
        id: r.id,
        method: r.method,
        path: r.path,
        description: r.description,
        backendType: r.backend.type,
      }))
    );
  });

  return { app, authService };
}

/**
 * Mounts the caller-facing (never admin-facing) surface: /auth login/
 * logout, and the dynamic dispatcher that serves every configured
 * endpoint. This is what a caller/API-consumer actually talks to in every
 * environment, dev or QA/Production alike -- unlike the admin UI/API,
 * which only the full/dev app ever mounts.
 */
export function mountDataPlaneRoutes(
  app: Express,
  { endpointRegistry, gatewaysRegistry, authService, logger }: { endpointRegistry: EndpointRegistry; gatewaysRegistry: GatewaysRegistry; authService: AuthService; logger: Logger }
): void {
  // Caller-facing login/logout -- a different audience from /admin/api
  // (whoever configures this instance) and from the business endpoints
  // below. See AUTH_DESIGN_NOTES.md.
  app.use("/auth", createAuthRouter(authService, logger));

  // Every configured endpoint is served by one dynamic handler that reads the
  // registry fresh per request (see dispatch.ts) -- this is what lets
  // endpoints created/edited via the admin API go live without a restart.
  app.use(createDynamicDispatcher(endpointRegistry, gatewaysRegistry, authService, logger));
}

/**
 * The 404 + centralized error handler. Must be mounted dead last, after
 * every other route (core, and in the full/dev app, admin too) -- an
 * Express error/fallback handler only catches what nothing before it
 * matched or threw past.
 */
export function mountTerminalHandlers(app: Express, logger: Logger): void {
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Not Found", path: req.path });
  });

  // Centralized error handler: known errors (ValidationError, BackendError)
  // carry a statusCode; anything else becomes a 500.
  app.use((err: Error & { statusCode?: number; backendBody?: unknown }, req: Request, res: Response, _next: NextFunction) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      logger.error({ err, path: req.path }, "unhandled error");
    } else {
      logger.warn({ err: err.message, path: req.path }, "request error");
    }
    res.status(statusCode).json({
      error: err.name ?? "Error",
      message: err.message,
      ...(err.backendBody !== undefined ? { backendBody: err.backendBody } : {}),
    });
  });
}
