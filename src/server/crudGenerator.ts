import { introspectSqlGateway, type IntrospectedTable, type IntrospectedProcedure } from "../connectors/sqlIntrospect";
import type { SqlGatewayConfig } from "../types/config";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { IntegrationRegistry } from "./integrationRegistry";
import type { AppRegistry } from "./appRegistry";
import { ValidationError } from "./errors";

/** Table/procedure names become URL path segments and integration/route-id
 * fragments; anything outside this is refused rather than risking a broken
 * path pattern or a surprising id. Real-world identifiers are practically
 * always this shape anyway. */
const SAFE_NAME = /^[A-Za-z0-9_]+$/;

export interface GeneratedEndpointSummary {
  id: string;
  method: string;
  path: string;
}

export interface SkippedSummary {
  kind: "table" | "procedure";
  name: string;
  reason: string;
}

export interface GenerateCrudResult {
  gateway: string;
  app: string;
  tablesFound: number;
  proceduresFound: number;
  proceduresSupported: boolean;
  created: GeneratedEndpointSummary[];
  skipped: SkippedSummary[];
}

/**
 * Introspects `gatewayName` (must be kind: "sql") and generates, for every
 * table (list / bulkCreate / bulkUpdate / bulkDelete) and, where the
 * dialect supports it, every stored procedure: one Integration (the
 * backend-calling/output-mapping half) plus one Route added to `appId`
 * (the public method+path, pointing at that Integration) -- see
 * WORKSPACE_APPS_DESIGN_NOTES.md. Never overwrites or fails on a conflict
 * -- an id already in use (as an Integration, or as a route id/method+path
 * already in `appId`) is skipped and reported, so this is always safe to
 * re-run, e.g. after adding a table.
 */
export async function generateCrudEndpointsForGateway(
  gatewaysRegistry: GatewaysRegistry,
  integrationRegistry: IntegrationRegistry,
  appRegistry: AppRegistry,
  gatewayName: string,
  appId: string
): Promise<GenerateCrudResult> {
  const resolved = gatewaysRegistry.getResolved().gateways[gatewayName];
  if (!resolved) {
    throw new ValidationError(`No gateway "${gatewayName}"`);
  }
  if (!("kind" in resolved) || resolved.kind !== "sql") {
    throw new ValidationError("Generating CRUD endpoints is only available for SQL/database gateways");
  }
  if (!appRegistry.get(appId)) {
    throw new ValidationError(`No app "${appId}"`);
  }
  const sqlGw = resolved as SqlGatewayConfig;
  const introspection = await introspectSqlGateway(sqlGw);

  const created: GeneratedEndpointSummary[] = [];
  const skipped: SkippedSummary[] = [];

  const tables = [...introspection.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const table of tables) {
    generateTableEndpoints(integrationRegistry, appRegistry, appId, gatewayName, table, created, skipped);
  }

  if (introspection.proceduresSupported) {
    const procedures = [...introspection.procedures].sort((a, b) => a.name.localeCompare(b.name));
    for (const proc of procedures) {
      generateProcedureEndpoint(integrationRegistry, appRegistry, appId, gatewayName, proc, created, skipped);
    }
  }

  return {
    gateway: gatewayName,
    app: appId,
    tablesFound: introspection.tables.length,
    proceduresFound: introspection.procedures.length,
    proceduresSupported: introspection.proceduresSupported,
    created,
    skipped,
  };
}

/**
 * Attempts to persist one generated Integration + Route; on any conflict
 * (an Integration id already in use, or a route id/method+path already
 * claimed in `appId`) records a skip instead of throwing, so one conflict
 * never aborts the whole generation. Always re-reads `appId`'s current
 * routes from appRegistry right before writing, so each call in a loop
 * sees every earlier call's result -- the same "fresh from the registry"
 * approach used everywhere else in this project.
 */
function tryUpsert(
  integrationRegistry: IntegrationRegistry,
  appRegistry: AppRegistry,
  appId: string,
  integrationConfig: unknown,
  meta: { id: string; method: string; path: string; description?: string },
  created: GeneratedEndpointSummary[],
  skipped: SkippedSummary[],
  kind: "table" | "procedure",
  name: string
): void {
  if (integrationRegistry.get(meta.id)) {
    skipped.push({ kind, name, reason: `integration id "${meta.id}" already exists` });
    return;
  }
  const app = appRegistry.get(appId);
  const routes = app?.routes ?? [];
  if (routes.some((r) => r.id === meta.id)) {
    skipped.push({ kind, name, reason: `route id "${meta.id}" already exists in app "${appId}"` });
    return;
  }
  const pathConflict = routes.find((r) => r.method === meta.method && r.path === meta.path);
  if (pathConflict) {
    skipped.push({
      kind,
      name,
      reason: `${meta.method} ${meta.path} is already used by route "${pathConflict.id}" in app "${appId}"`,
    });
    return;
  }
  try {
    const { config: integration } = integrationRegistry.upsert(integrationConfig);
    const currentApp = appRegistry.get(appId);
    if (!currentApp) throw new ValidationError(`No app "${appId}"`);
    appRegistry.upsert({
      ...currentApp,
      routes: [
        ...currentApp.routes,
        { id: meta.id, method: meta.method, path: meta.path, description: meta.description, integration: integration.id },
      ],
    });
    created.push({ id: meta.id, method: meta.method, path: meta.path });
  } catch (err) {
    // Roll back the Integration if the Route couldn't be added, so a
    // failed generation never leaves an orphaned Integration with no
    // Route pointing at it.
    integrationRegistry.remove(meta.id);
    skipped.push({ kind, name, reason: err instanceof Error ? err.message : String(err) });
  }
}

function generateTableEndpoints(
  integrationRegistry: IntegrationRegistry,
  appRegistry: AppRegistry,
  appId: string,
  gatewayName: string,
  table: IntrospectedTable,
  created: GeneratedEndpointSummary[],
  skipped: SkippedSummary[]
): void {
  if (!SAFE_NAME.test(table.name)) {
    skipped.push({ kind: "table", name: table.name, reason: "table name has characters unsafe for a URL path -- skipped" });
    return;
  }

  const basePath = `/api/${gatewayName}/${table.name}`;
  const columnNames = table.columns.map((c) => c.name);
  const pk = table.primaryKey;

  const listId = `${gatewayName}-${table.name}-list`;
  tryUpsert(
    integrationRegistry,
    appRegistry,
    appId,
    {
      id: listId,
      description:
        `List/filter rows from "${table.name}". Query params: any column name for an exact-match filter, ` +
        `plus limit/offset/sort/order` +
        (pk.length === 1 ? `, and ids=v1,v2,... to fetch specific rows by ${pk[0]}.` : "."),
      input: [],
      backend: { type: "sql", gateway: gatewayName, table: table.name, operation: "list", primaryKey: pk, columns: columnNames },
      // Wrapped in a named top-level array field, not a bare output.root --
      // that concept was removed (see WORKSPACE_APPS_DESIGN_NOTES.md /
      // TRANSFORM_FUNCTIONS_DESIGN_NOTES.md); this template had been missed
      // by that earlier sweep until now.
      output: {
        fields: [{ kind: "array", target: "rows", root: "$[*]", fields: columnNames.map((c) => ({ target: c, source: `$.${c}` })) }],
      },
    },
    { id: listId, method: "GET", path: basePath },
    created,
    skipped,
    "table",
    table.name
  );

  const createId = `${gatewayName}-${table.name}-create`;
  tryUpsert(
    integrationRegistry,
    appRegistry,
    appId,
    {
      id: createId,
      description: `Bulk-insert rows into "${table.name}". Body: { "rows": [ {...column values...}, ... ] }.`,
      input: [],
      backend: { type: "sql", gateway: gatewayName, table: table.name, operation: "bulkCreate" },
      output: {
        fields: [
          { target: "insertedCount", source: "$.insertedCount" },
          { target: "rows", source: "$.rows", default: null },
        ],
      },
    },
    { id: createId, method: "POST", path: basePath },
    created,
    skipped,
    "table",
    table.name
  );

  if (pk.length === 0) {
    skipped.push({
      kind: "table",
      name: table.name,
      reason: "table has no primary key -- only list/create endpoints were generated (update/delete need one to target specific rows)",
    });
    return;
  }

  const updateId = `${gatewayName}-${table.name}-update`;
  tryUpsert(
    integrationRegistry,
    appRegistry,
    appId,
    {
      id: updateId,
      description:
        `Bulk-update rows in "${table.name}" by primary key [${pk.join(", ")}]. ` +
        `Body: { "updates": [ { "key": {...}, "fields": {...} }, ... ] }.`,
      input: [],
      backend: { type: "sql", gateway: gatewayName, table: table.name, operation: "bulkUpdate", primaryKey: pk },
      output: {
        fields: [
          { target: "updatedCount", source: "$.updatedCount" },
          { target: "results", source: "$.results", default: [] },
        ],
      },
    },
    { id: updateId, method: "PATCH", path: basePath },
    created,
    skipped,
    "table",
    table.name
  );

  const deleteId = `${gatewayName}-${table.name}-delete`;
  tryUpsert(
    integrationRegistry,
    appRegistry,
    appId,
    {
      id: deleteId,
      description:
        `Bulk-delete rows from "${table.name}" by primary key [${pk.join(", ")}]. Body: { "keys": [ {...}, ... ] }.`,
      input: [],
      backend: { type: "sql", gateway: gatewayName, table: table.name, operation: "bulkDelete", primaryKey: pk },
      output: {
        fields: [
          { target: "deletedCount", source: "$.deletedCount" },
          { target: "results", source: "$.results", default: [] },
        ],
      },
    },
    { id: deleteId, method: "DELETE", path: basePath },
    created,
    skipped,
    "table",
    table.name
  );
}

function generateProcedureEndpoint(
  integrationRegistry: IntegrationRegistry,
  appRegistry: AppRegistry,
  appId: string,
  gatewayName: string,
  proc: IntrospectedProcedure,
  created: GeneratedEndpointSummary[],
  skipped: SkippedSummary[]
): void {
  if (!SAFE_NAME.test(proc.name)) {
    skipped.push({ kind: "procedure", name: proc.name, reason: "procedure name has characters unsafe for a URL path -- skipped" });
    return;
  }

  const path = `/api/${gatewayName}/proc/${proc.name}`;
  const id = `${gatewayName}-proc-${proc.name}`;
  tryUpsert(
    integrationRegistry,
    appRegistry,
    appId,
    {
      id,
      description: `Call stored procedure "${proc.name}"${proc.params.length ? ` with params: ${proc.params.join(", ")}` : ""}.`,
      input: proc.params.map((name) => ({ name, in: "body", required: false, type: "string" })),
      backend: { type: "sql", gateway: gatewayName, procedure: proc.name, procedureParams: proc.params },
      output: { fields: [{ target: "result", source: "$" }] },
    },
    { id, method: "POST", path },
    created,
    skipped,
    "procedure",
    proc.name
  );
}
