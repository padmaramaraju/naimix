import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { endpointConfigSchema, backendSchema, outputSchema, inputParamSchema } from "../config/schema";
import type { InputParamDef } from "../types/config";
import { callBackend, closeAllSqlConnections, getBackendGatewayName } from "../connectors";
import { mapResponse } from "../transform/mapper";
import { ValidationError } from "./errors";
import { generateCrudEndpointsForGateway } from "./crudGenerator";
import { generateOpenApiDocument } from "./openapiGenerator";
import { resolveConfigDir, saveWorkspaceSettings } from "./workspaceSettings";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { AuthService } from "../auth/authService";
import type { Logger } from "./logger";
import type { ResolvedParams } from "../connectors/paramSubst";

export interface AdminApiDeps {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  authService: AuthService;
  logger: Logger;
  /** Mutable holder for "which workspace is this instance currently
   * pointed at" -- undefined when running in legacy mode (ENDPOINTS_DIR/
   * GATEWAYS_FILE set independently, not as one shared folder). Updated
   * in place by PUT /settings; see workspaceSettings.ts. */
  workspace: { configDir?: string };
  /** Where to persist the chosen workspace so it survives a restart
   * (see workspaceSettings.ts). Required for PUT /settings to work. */
  settingsFile: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const BACKEND_TYPES = ["json", "xml", "soap", "sql"] as const;
const TRANSFORMS = ["toString", "toNumber", "toBoolean", "trim", "upper", "lower"] as const;
const SQL_CLIENTS = ["sqlite3", "pg", "mysql2", "mssql", "better-sqlite3"] as const;

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** Builds input params directly from a plain object (the admin UI's "test
 * this endpoint" panel) instead of an Express Request, applying the same
 * required/default/type-coercion rules as a real request would. */
function buildTestParams(input: InputParamDef[], supplied: Record<string, unknown>): ResolvedParams {
  const result: ResolvedParams = {};
  for (const p of input) {
    let raw = supplied[p.name];
    // An explicit test-panel override always wins; otherwise an env-sourced
    // param defaults to the real environment value, same as a live request.
    if ((raw === undefined || raw === "") && p.in === "env") {
      raw = process.env[p.envVar || p.name];
    }
    if (raw === undefined || raw === "") {
      if (p.default !== undefined) {
        result[p.name] = p.default;
        continue;
      }
      if (p.required) {
        throw new ValidationError(`Missing required parameter "${p.name}" for test call`);
      }
      continue;
    }
    if (p.type === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new ValidationError(`Parameter "${p.name}" must be a number`);
      result[p.name] = n;
    } else if (p.type === "boolean") {
      result[p.name] = raw === true || raw === "true";
    } else {
      result[p.name] = String(raw);
    }
  }
  return result;
}

export function createAdminApiRouter({
  endpointRegistry,
  gatewaysRegistry,
  authProvidersRegistry,
  authService,
  logger,
  workspace,
  settingsFile,
}: AdminApiDeps): Router {
  const router = Router();
  const adminLogger = logger.child({ component: "admin-api" });

  // Lists the schema's enum values so the browser UI never has to hardcode
  // (and risk drifting from) what src/config/schema.ts actually allows.
  router.get("/meta", (_req, res) => {
    res.json({
      methods: METHODS,
      backendTypes: BACKEND_TYPES,
      transforms: TRANSFORMS,
      sqlClients: SQL_CLIENTS,
      paramLocations: ["path", "query", "header", "body", "env"],
      paramTypes: ["string", "number", "boolean"],
      // Mirrors AuthService's own isDevMode() gate -- the admin UI reads
      // this to decide whether to render the Active sessions panel's
      // token/backend-token/refresh-token columns and its dev-only warning
      // banner. The server-side gate in listSessions() is what actually
      // withholds the data in production; this flag only controls whether
      // the UI bothers asking for it.
      devMode: process.env.NODE_ENV !== "production",
    });
  });

  // ---- Endpoints ----

  router.get("/endpoints", (_req, res) => {
    res.json(endpointRegistry.list());
  });

  router.get("/endpoints/:id", (req, res) => {
    const endpoint = endpointRegistry.get(req.params.id);
    if (!endpoint) return res.status(404).json({ error: "NotFound", message: `No endpoint "${req.params.id}"` });
    res.json(endpoint);
  });

  router.post(
    "/endpoints",
    asyncHandler(async (req, res) => {
      const { config, file } = endpointRegistry.upsert(req.body);
      adminLogger.info(`Created endpoint ${config.method} ${config.path} (${config.id}) -> ${file}`);
      res.status(201).json({ endpoint: config, file });
    })
  );

  router.put(
    "/endpoints/:id",
    asyncHandler(async (req, res) => {
      if (!endpointRegistry.get(req.params.id)) {
        return res.status(404).json({ error: "NotFound", message: `No endpoint "${req.params.id}"` });
      }
      const { config, file } = endpointRegistry.upsert(req.body, { excludeId: req.params.id });
      adminLogger.info(`Updated endpoint ${config.method} ${config.path} (${config.id}) -> ${file}`);
      res.json({ endpoint: config, file });
    })
  );

  router.delete("/endpoints/:id", (req, res) => {
    const removed = endpointRegistry.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: "NotFound", message: `No endpoint "${req.params.id}"` });
    adminLogger.info(`Deleted endpoint ${req.params.id}`);
    res.status(204).end();
  });

  // Runs an already-saved endpoint live with caller-supplied test param values
  // and returns BOTH the raw backend response and the mapped output, so the
  // output-mapping form can be tuned against real data.
  router.post(
    "/endpoints/:id/test",
    asyncHandler(async (req, res) => {
      const endpoint = endpointRegistry.get(req.params.id);
      if (!endpoint) return res.status(404).json({ error: "NotFound", message: `No endpoint "${req.params.id}"` });

      const supplied = (req.body?.params ?? {}) as Record<string, unknown>;
      const params = buildTestParams(endpoint.input, supplied);
      // A generated table-CRUD endpoint (list/bulkCreate/bulkUpdate/bulkDelete)
      // reads straight from the raw query string / JSON body rather than the
      // declared `input` params above -- an advanced caller can exercise one
      // of those from this same test endpoint by passing `rawQuery`/`rawBody`
      // explicitly, since the "Try it" UI panel itself only has fields for
      // scalar named params (see admin.js for the corresponding UI note).
      const raw = await callBackend(endpoint.backend, {
        gateways: gatewaysRegistry.getResolved(),
        params,
        logger: adminLogger,
        rawQuery: (req.body?.rawQuery ?? undefined) as Record<string, unknown> | undefined,
        rawBody: req.body?.rawBody,
      });
      const mapped = mapResponse(raw, endpoint.output);
      res.json({ raw, mapped });
    })
  );

  // Calls a backend that hasn't been saved as an endpoint yet -- lets the UI
  // fetch a sample response WHILE building an endpoint, before Save.
  router.post(
    "/test-backend",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({
        input: z.array(inputParamSchema).optional().default([]),
        backend: backendSchema,
        params: z.record(z.unknown()).optional().default({}),
        rawQuery: z.record(z.unknown()).optional(),
        rawBody: z.unknown().optional(),
      });
      const { input, backend, params: supplied, rawQuery, rawBody } = bodySchema.parse(req.body);
      const params = buildTestParams(input, supplied);
      const raw = await callBackend(backend, {
        gateways: gatewaysRegistry.getResolved(),
        params,
        logger: adminLogger,
        rawQuery,
        rawBody,
      });
      res.json({ raw });
    })
  );

  // Re-applies an output mapping to an already-fetched sample response, so
  // the UI can iterate on `output.fields` without re-calling the backend
  // (and re-running SQL writes / non-idempotent operations) every keystroke.
  router.post("/test-mapping", (req, res) => {
    const bodySchema = z.object({ raw: z.unknown(), output: outputSchema });
    const { raw, output } = bodySchema.parse(req.body);
    res.json({ mapped: mapResponse(raw, output) });
  });

  router.post(
    "/reload",
    asyncHandler(async (_req, res) => {
      const { errors } = endpointRegistry.reloadFromDisk();
      gatewaysRegistry.reloadFromDisk();
      authProvidersRegistry.reloadFromDisk();
      res.json({ endpointCount: endpointRegistry.list().length, errors });
    })
  );

  // ---- Workspace ----
  // Each user runs their own instance of this app on their own machine (no
  // login, no multi-tenant serving) and keeps endpoints+gateways in a local
  // Git checkout of a shared team repo -- these two endpoints let the admin
  // UI point THIS instance at any such folder. Checking in/out of Git stays
  // entirely outside the app; this only ever reads/writes plain files.

  router.get("/settings", (_req, res) => {
    res.json({
      configDir: workspace.configDir ?? null,
      endpointsDir: endpointRegistry.getDir(),
      gatewaysFile: gatewaysRegistry.getFilePath(),
      authProvidersFile: authProvidersRegistry.getFilePath(),
      endpointCount: endpointRegistry.list().length,
      gatewayCount: Object.keys(gatewaysRegistry.listRaw()).length,
      authProviderCount: Object.keys(authProvidersRegistry.listRaw()).length,
    });
  });

  router.put(
    "/settings",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({ configDir: z.string().min(1) });
      const { configDir: submitted } = bodySchema.parse(req.body);
      const configDir = path.resolve(submitted);

      if (!fs.existsSync(configDir) || !fs.statSync(configDir).isDirectory()) {
        throw new ValidationError(
          `configDir: "${configDir}" doesn't exist as a folder on this machine. Check it out (e.g. clone/pull the Git repo) first, then point the app at it.`
        );
      }

      const { endpointsDir, gatewaysFile, authProvidersFile } = resolveConfigDir(configDir);

      // Any SQL gateway pools opened for the OLD folder's gateways (e.g. an
      // open sqlite file handle, or a live pg/mysql pool) are no longer
      // relevant once we're serving a different gateways.yaml -- close them
      // now rather than leaking them until process exit.
      await closeAllSqlConnections();

      const { errors: endpointErrors } = endpointRegistry.setDir(endpointsDir);
      gatewaysRegistry.setFilePath(gatewaysFile);
      authProvidersRegistry.setFilePath(authProvidersFile);
      workspace.configDir = configDir;
      saveWorkspaceSettings(settingsFile, { configDir });

      adminLogger.info(`Switched workspace to "${configDir}"`);
      res.json({
        configDir,
        endpointsDir,
        gatewaysFile,
        authProvidersFile,
        endpointCount: endpointRegistry.list().length,
        endpointErrors,
        gatewayCount: Object.keys(gatewaysRegistry.listRaw()).length,
        authProviderCount: Object.keys(authProvidersRegistry.listRaw()).length,
      });
    })
  );

  // ---- Gateways ----

  router.get("/gateways", (_req, res) => {
    res.json(gatewaysRegistry.listRedacted());
  });

  router.get("/gateways/:name", (req, res) => {
    const gw = gatewaysRegistry.getRaw(req.params.name);
    if (!gw) return res.status(404).json({ error: "NotFound", message: `No gateway "${req.params.name}"` });
    // Reuse the same redaction as the list endpoint -- editing a secret
    // means retyping it, not reading it back into the browser.
    res.json(gatewaysRegistry.listRedacted()[req.params.name]);
  });

  router.post(
    "/gateways",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({ name: z.string().min(1), config: z.unknown() });
      const { name, config } = bodySchema.parse(req.body);
      if (gatewaysRegistry.getRaw(name)) {
        return res.status(409).json({ error: "Conflict", message: `Gateway "${name}" already exists` });
      }
      gatewaysRegistry.upsert(name, config);
      adminLogger.info(`Created gateway "${name}"`);
      res.status(201).json({ name });
    })
  );

  router.put(
    "/gateways/:name",
    asyncHandler(async (req, res) => {
      if (!gatewaysRegistry.getRaw(req.params.name)) {
        return res.status(404).json({ error: "NotFound", message: `No gateway "${req.params.name}"` });
      }
      gatewaysRegistry.upsert(req.params.name, req.body?.config ?? req.body);
      adminLogger.info(`Updated gateway "${req.params.name}"`);
      res.json({ name: req.params.name });
    })
  );

  // Tests a gateway's real reachability without saving it first -- currently
  // meaningful only for kind: "sql". `name` (optional) lets an in-progress
  // edit of an existing gateway reuse its stored secrets for any sensitive
  // field the draft left blank, same as saving would.
  router.post(
    "/gateways/test-connection",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({ name: z.string().optional(), config: z.unknown() });
      const { name, config } = bodySchema.parse(req.body);
      const result = await gatewaysRegistry.testConnection(name, config);
      res.json(result);
    })
  );

  // Introspects a SQL gateway and generates list/bulkCreate/bulkUpdate/
  // bulkDelete endpoints for every table (plus one endpoint per stored
  // procedure, where the dialect supports them). Never overwrites an
  // existing endpoint -- any id/path conflict is skipped and reported, so
  // this is safe to re-run.
  router.post(
    "/gateways/:name/generate-crud",
    asyncHandler(async (req, res) => {
      if (!gatewaysRegistry.getRaw(req.params.name)) {
        return res.status(404).json({ error: "NotFound", message: `No gateway "${req.params.name}"` });
      }
      const summary = await generateCrudEndpointsForGateway(gatewaysRegistry, endpointRegistry, req.params.name);
      adminLogger.info(
        `Generated CRUD endpoints for gateway "${req.params.name}": ${summary.created.length} created, ${summary.skipped.length} skipped`
      );
      res.json(summary);
    })
  );

  router.delete("/gateways/:name", (req, res) => {
    const name = req.params.name;
    const dependents = endpointRegistry.list().filter((r) => getBackendGatewayName(r.backend) === name);
    if (dependents.length > 0) {
      return res.status(409).json({
        error: "Conflict",
        message: `Gateway "${name}" is used by ${dependents.length} endpoint(s)`,
        endpoints: dependents.map((r) => r.id),
      });
    }
    const removed = gatewaysRegistry.remove(name);
    if (!removed) return res.status(404).json({ error: "NotFound", message: `No gateway "${name}"` });
    adminLogger.info(`Deleted gateway "${name}"`);
    res.status(204).end();
  });

  // ---- Auth providers ----
  // See AUTH_DESIGN_NOTES.md. A gateway's `requiresAuth` field names one of
  // these by name (validated at call time, not at gateway-save time -- same
  // "a name is just a name until something calls it" convention as a
  // backend's own `gateway` reference).

  router.get("/auth-providers", (_req, res) => {
    res.json(authProvidersRegistry.listRedacted());
  });

  router.get("/auth-providers/:name", (req, res) => {
    const provider = authProvidersRegistry.getRaw(req.params.name);
    if (!provider) return res.status(404).json({ error: "NotFound", message: `No auth provider "${req.params.name}"` });
    res.json(authProvidersRegistry.listRedacted()[req.params.name]);
  });

  router.post(
    "/auth-providers",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({ name: z.string().min(1), config: z.unknown() });
      const { name, config } = bodySchema.parse(req.body);
      if (authProvidersRegistry.getRaw(name)) {
        return res.status(409).json({ error: "Conflict", message: `Auth provider "${name}" already exists` });
      }
      authProvidersRegistry.upsert(name, config);
      adminLogger.info(`Created auth provider "${name}"`);
      res.status(201).json({ name });
    })
  );

  router.put(
    "/auth-providers/:name",
    asyncHandler(async (req, res) => {
      if (!authProvidersRegistry.getRaw(req.params.name)) {
        return res.status(404).json({ error: "NotFound", message: `No auth provider "${req.params.name}"` });
      }
      authProvidersRegistry.upsert(req.params.name, req.body?.config ?? req.body);
      adminLogger.info(`Updated auth provider "${req.params.name}"`);
      res.json({ name: req.params.name });
    })
  );

  // Attempts a real login against an auth provider's config (saved, via
  // `name`, or a draft still being edited) without creating a session --
  // the auth-provider counterpart to /gateways/test-connection. Useful for
  // checking a bind DN, filter, or secret is right before saving, without
  // resorting to a separate curl/POST-/auth/login round trip.
  router.post(
    "/auth-providers/test-login",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({
        name: z.string().optional(),
        config: z.unknown(),
        credentials: z.record(z.unknown()).optional().default({}),
      });
      const { name, config, credentials } = bodySchema.parse(req.body);
      const result = await authProvidersRegistry.testLogin(name, config, credentials);
      res.json(result);
    })
  );

  router.delete("/auth-providers/:name", (req, res) => {
    const name = req.params.name;
    const dependents = Object.entries(gatewaysRegistry.listRaw()).filter(
      ([, gw]) => "requiresAuth" in gw && gw.requiresAuth === name
    );
    if (dependents.length > 0) {
      return res.status(409).json({
        error: "Conflict",
        message: `Auth provider "${name}" is required by ${dependents.length} gateway(s)`,
        gateways: dependents.map(([gwName]) => gwName),
      });
    }
    const removed = authProvidersRegistry.remove(name);
    if (!removed) return res.status(404).json({ error: "NotFound", message: `No auth provider "${name}"` });
    adminLogger.info(`Deleted auth provider "${name}"`);
    res.status(204).end();
  });

  // ---- Sessions ----
  // What's actually held in the in-memory session store right now (see
  // AUTH_DESIGN_NOTES.md's opaque-token design and sessionStore.ts) -- every
  // caller session currently live across every provider, for whoever
  // configures this instance to see without a debugger attached. Outside
  // production, this also includes a session's real bearer token and the
  // backend/refresh token it wraps, for local debugging -- see
  // AuthService.listSessions()'s `isDevMode()` gate. Production always omits
  // those three, whatever this route returns is decided server-side by
  // listSessions() itself -- there's no separate check to bypass here.

  router.get(
    "/sessions",
    asyncHandler(async (_req, res) => {
      res.json(await authService.listSessions());
    })
  );

  router.delete(
    "/sessions/:id",
    asyncHandler(async (req, res) => {
      const revoked = await authService.revokeSession(req.params.id);
      if (!revoked) return res.status(404).json({ error: "NotFound", message: `No active session "${req.params.id}"` });
      adminLogger.info(`Revoked session "${req.params.id}"`);
      res.status(204).end();
    })
  );

  // ---- Export ----
  // Lets whoever's configuring this workspace hand it to another tool: a
  // standard OpenAPI document describing every caller-facing route, and a
  // ready-to-run MCP server that talks to this same live instance. Both
  // reflect the CURRENT config at request time -- there's nothing generated
  // ahead of time to go stale.

  router.get("/export/openapi.json", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const doc = generateOpenApiDocument({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, baseUrl });
    res.setHeader("Content-Disposition", 'attachment; filename="naimix-openapi.json"');
    res.json(doc);
  });

  // The MCP server is a single static file checked into this repo (not
  // generated per-workspace) -- it discovers endpoints/gateways/auth
  // providers itself, at its own startup, by calling this same admin API.
  // See mcp-server/naimix-mcp-server.js's own header comment for the full
  // design and setup instructions.
  router.get("/export/mcp-server", (_req, res) => {
    const filePath = path.resolve(__dirname, "../../mcp-server/naimix-mcp-server.js");
    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "NotFound", message: "mcp-server/naimix-mcp-server.js is missing from this installation." });
    }
    res.download(filePath, "naimix-mcp-server.js");
  });

  // Zod validation errors -> 400 with details, instead of falling through
  // to the generic 500 handler in app.ts.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "ValidationError", message: "Invalid request body", issues: err.issues });
      return;
    }
    next(err);
  });

  return router;
}
