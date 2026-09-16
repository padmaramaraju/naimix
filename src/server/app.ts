import path from "node:path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createDynamicDispatcher } from "./dispatch";
import { createAdminApiRouter } from "./adminApi";
import { requireAdminAuth } from "./adminAuth";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { Logger } from "./logger";

export interface CreateAppOptions {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
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
  logger,
  adminUiDir,
  workspace,
  settingsFile,
}: CreateAppOptions): Express {
  const app = express();
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

  // Admin UI: a static browser app (served publicly) talking to a
  // token-gated API. The UI itself has no secrets in it; every API call it
  // makes carries the bearer token entered on the page.
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
      logger,
      workspace: workspace ?? {},
      settingsFile: settingsFile ?? path.resolve(process.cwd(), "data/settings.json"),
    })
  );

  // Every configured endpoint is served by one dynamic handler that reads the
  // registry fresh per request (see dispatch.ts) -- this is what lets
  // endpoints created/edited via the admin API go live without a restart.
  app.use(createDynamicDispatcher(endpointRegistry, gatewaysRegistry, logger));

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

  return app;
}
