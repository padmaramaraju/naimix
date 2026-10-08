import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { endpointConfigSchema, backendSchema, outputSchema, inputParamSchema } from "../config/schema";
import type { InputParamDef } from "../types/config";
import { callBackend, closeAllSqlConnections, getBackendGatewayName } from "../connectors";
import { mapResponse } from "../transform/mapper";
import { collectFunctionNames } from "../transform/functionRefs";
import { compileFunctionSource, runInSandbox } from "./functionCompiler";
import { ValidationError } from "./errors";
import { generateCrudEndpointsForGateway } from "./crudGenerator";
import { generateOpenApiDocument } from "./openapiGenerator";
import { pickFolderNative } from "./nativeFolderPicker";
import { resolveConfigDir, saveWorkspaceSettings } from "./workspaceSettings";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { FunctionRegistry } from "../transform/functionRegistry";
import type { AuthService } from "../auth/authService";
import type { Logger } from "./logger";
import type { ResolvedParams } from "../connectors/paramSubst";

export interface ConsoleApiDeps {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  functionRegistry: FunctionRegistry;
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
  /** Opens a native OS folder-picker dialog for POST /settings/select-folder,
   * resolving to the chosen path or null if cancelled. Defaults to the real
   * one (nativeFolderPicker.ts); overridable so tests can exercise the
   * route's own logic (the null/error handling) without actually popping up
   * a GUI dialog in CI. */
  pickFolder?: (startDir: string) => Promise<string | null>;
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

/** Builds input params directly from a plain object (the console UI's "test
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

export function createConsoleApiRouter({
  endpointRegistry,
  gatewaysRegistry,
  authProvidersRegistry,
  functionRegistry,
  authService,
  logger,
  workspace,
  settingsFile,
  pickFolder = pickFolderNative,
}: ConsoleApiDeps): Router {
  const router = Router();
  const consoleLogger = logger.child({ component: "console-api" });

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
      // Mirrors AuthService's own isDevMode() gate -- the console UI reads
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
      consoleLogger.info(`Created endpoint ${config.method} ${config.path} (${config.id}) -> ${file}`);
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
      consoleLogger.info(`Updated endpoint ${config.method} ${config.path} (${config.id}) -> ${file}`);
      res.json({ endpoint: config, file });
    })
  );

  router.delete("/endpoints/:id", (req, res) => {
    const removed = endpointRegistry.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: "NotFound", message: `No endpoint "${req.params.id}"` });
    consoleLogger.info(`Deleted endpoint ${req.params.id}`);
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
      // scalar named params (see console.js for the corresponding UI note).
      const raw = await callBackend(endpoint.backend, {
        gateways: gatewaysRegistry.getResolved(),
        params,
        logger: consoleLogger,
        rawQuery: (req.body?.rawQuery ?? undefined) as Record<string, unknown> | undefined,
        rawBody: req.body?.rawBody,
      });
      const mapped = mapResponse(raw, endpoint.output, { functions: functionRegistry, params });
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
        logger: consoleLogger,
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
    res.json({ mapped: mapResponse(raw, output, { functions: functionRegistry }) });
  });

  router.post(
    "/reload",
    asyncHandler(async (_req, res) => {
      // Functions reload FIRST: endpointRegistry's own reload validates
      // every transform/postProcess name reference against whatever the
      // function registry currently has loaded (see endpointRegistry.ts),
      // so a transform function someone just hand-edited on disk (outside
      // the Console's own save flow -- e.g. a git pull) needs to be picked
      // up before that check runs, not after.
      const { errors: functionErrors } = functionRegistry.loadFromDisk();
      const { errors } = endpointRegistry.reloadFromDisk();
      gatewaysRegistry.reloadFromDisk();
      authProvidersRegistry.reloadFromDisk();
      res.json({ endpointCount: endpointRegistry.list().length, errors, functionErrors });
    })
  );

  // ---- Custom transform functions ----
  // See TRANSFORM_FUNCTIONS_DESIGN_NOTES.md. These four routes are the
  // ENTIRE dynamic-reload surface for this feature -- nothing in
  // dataPlaneApp.ts/opsApi.ts (QA/Production) exposes anything like them,
  // by design (see FunctionRegistry's own doc comment).

  router.get("/functions", (_req, res) => {
    res.json({ names: functionRegistry.list() });
  });

  // Reads back the .ts SOURCE (not the compiled .js) for editing -- the
  // Console always edits/displays the original author-written code.
  router.get("/functions/:name", (req, res) => {
    const name = req.params.name;
    if (!functionRegistry.has(name)) {
      return res.status(404).json({ error: "NotFound", message: `No function "${name}"` });
    }
    const sourceFile = path.join(functionRegistry.getDir(), `${name}.ts`);
    let code = "";
    try {
      code = fs.readFileSync(sourceFile, "utf8");
    } catch {
      // The compiled .js loaded fine but its .ts source is missing (e.g.
      // hand-added outside the Console) -- not an error, just nothing to
      // show in the editor.
    }
    res.json({ name, code });
  });

  // Runs typed-but-not-yet-saved code in the sandbox (see
  // functionCompiler.ts's runInSandbox) against a sample value/ctx the
  // Console already has on hand (either a value picked from the Test
  // tab's fetched sample, or the currently-mapped output, for a
  // postProcess function under test) -- lets someone iterate on a
  // function's logic before it's ever written to disk or wired into a
  // real endpoint.
  router.post(
    "/functions/test",
    asyncHandler(async (req, res) => {
      const bodySchema = z.object({
        code: z.string().min(1),
        value: z.unknown(),
        ctx: z
          .object({ item: z.unknown().optional(), raw: z.unknown().optional(), params: z.record(z.unknown()).optional() })
          .optional()
          .default({}),
      });
      const { code, value, ctx } = bodySchema.parse(req.body);
      const compiled = compileFunctionSource(code);
      res.json(runInSandbox(compiled, value, ctx));
    })
  );

  // Compiles + persists a function: writes BOTH <name>.ts (the source, as
  // written) and <name>.js (compiled via compileFunctionSource) to
  // <configDir>/transforms/, then immediately hot-reloads it into this
  // dev server's own live registry (FunctionRegistry.reloadOne) so an
  // endpoint referencing it works on the very next request -- see
  // FunctionRegistry's own doc comment for why this reload path only
  // ever runs here, never in QA/Production.
  router.put(
    "/functions/:name",
    asyncHandler(async (req, res) => {
      const name = req.params.name;
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        throw new ValidationError(
          `Function name "${name}" is invalid -- use letters, digits, "_" or "-", starting with a letter.`
        );
      }
      const { code } = z.object({ code: z.string().min(1) }).parse(req.body);
      const compiled = compileFunctionSource(code);

      const dir = functionRegistry.getDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.ts`), code, "utf8");
      fs.writeFileSync(path.join(dir, `${name}.js`), compiled, "utf8");
      functionRegistry.reloadOne(name);

      consoleLogger.info(`Saved transform function "${name}"`);
      res.json({ name });
    })
  );

  router.delete("/functions/:name", (req, res) => {
    const name = req.params.name;
    if (!functionRegistry.has(name)) {
      return res.status(404).json({ error: "NotFound", message: `No function "${name}"` });
    }
    const dependents = endpointRegistry.list().filter((e) => collectFunctionNames(e.output).includes(name));
    if (dependents.length > 0) {
      return res.status(409).json({
        error: "Conflict",
        message: `Function "${name}" is used by ${dependents.length} endpoint(s)`,
        endpoints: dependents.map((e) => e.id),
      });
    }
    const dir = functionRegistry.getDir();
    for (const ext of [".ts", ".js"]) {
      const file = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    functionRegistry.remove(name);
    consoleLogger.info(`Deleted transform function "${name}"`);
    res.status(204).end();
  });

  // ---- Workspace ----
  // Each user runs their own instance of this app on their own machine (no
  // login, no multi-tenant serving) and keeps endpoints+gateways in a local
  // Git checkout of a shared team repo -- these two endpoints let the console
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

  router.get("/settings/folders", asyncHandler(async (req, res) => {
    const { dir } = z.object({ dir: z.string().min(1).optional() }).parse(req.query);
    const currentDir = path.resolve(dir ?? workspace.configDir ?? path.dirname(endpointRegistry.getDir()));
    try {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      const folders = entries.filter(entry => entry.isDirectory())
        .map(entry => ({ name: entry.name, path: path.join(currentDir, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(currentDir);
      res.json({ path: currentDir, parent: parent === currentDir ? null : parent, folders });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) {
        throw new ValidationError("This folder is unavailable or cannot be read. Choose another folder.");
      }
      throw err;
    }
  }));

  // Opens a native OS folder-picker dialog on the machine running THIS
  // server (the console UI's "Browse..." button) and returns the chosen
  // absolute path for the form to fill in -- it never saves anything
  // itself, same division of labor as the rest of this workspace-switching
  // flow (PUT /settings still does the actual switch). `configDir: null`
  // means the user cancelled the dialog, not an error -- the UI leaves the
  // text field alone in that case. See nativeFolderPicker.ts for why this
  // doesn't go through the `dialog-node` package (it has no folder-picking
  // mode, only a file one).
  router.post(
    "/settings/select-folder",
    asyncHandler(async (req, res) => {
      const { startDir } = z.object({ startDir: z.string().optional() }).parse(req.body ?? {});
      const from = path.resolve(startDir || workspace.configDir || path.dirname(endpointRegistry.getDir()));
      try {
        const configDir = await pickFolder(from);
        res.json({ configDir });
      } catch (err) {
        // "Couldn't launch/run the picker" (missing zenity, unsupported OS,
        // ...) -- surfaced the same way a bad typed-in path is, since the
        // console UI shows either one inline in the same error slot.
        throw new ValidationError(err instanceof Error ? err.message : "Couldn't open the folder picker.");
      }
    })
  );

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

      const { endpointsDir, gatewaysFile, authProvidersFile, transformsDir } = resolveConfigDir(configDir);

      // Any SQL gateway pools opened for the OLD folder's gateways (e.g. an
      // open sqlite file handle, or a live pg/mysql pool) are no longer
      // relevant once we're serving a different gateways.yaml -- close them
      // now rather than leaking them until process exit.
      await closeAllSqlConnections();

      // Functions repoint+reload BEFORE endpoints: the new workspace's
      // endpoints may reference function names that only exist in ITS
      // transforms/ folder (not the old workspace's), and endpointRegistry
      // validates those names against whatever functionRegistry currently
      // holds (see endpointRegistry.ts) -- so the registry has to already
      // be pointed at the new folder by the time endpoints reload.
      functionRegistry.setDir(transformsDir);
      const { errors: endpointErrors } = endpointRegistry.setDir(endpointsDir);
      gatewaysRegistry.setFilePath(gatewaysFile);
      authProvidersRegistry.setFilePath(authProvidersFile);
      workspace.configDir = configDir;
      saveWorkspaceSettings(settingsFile, { configDir });

      consoleLogger.info(`Switched workspace to "${configDir}"`);
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
      consoleLogger.info(`Created gateway "${name}"`);
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
      consoleLogger.info(`Updated gateway "${req.params.name}"`);
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
      consoleLogger.info(
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
    consoleLogger.info(`Deleted gateway "${name}"`);
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
      consoleLogger.info(`Created auth provider "${name}"`);
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
      consoleLogger.info(`Updated auth provider "${req.params.name}"`);
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
    consoleLogger.info(`Deleted auth provider "${name}"`);
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
      consoleLogger.info(`Revoked session "${req.params.id}"`);
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
  // providers itself, at its own startup, by calling this same console API.
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
