import { introspectSqlGateway, type IntrospectedTable, type IntrospectedProcedure } from "../connectors/sqlIntrospect";
import type { SqlGatewayConfig } from "../types/config";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { EndpointRegistry } from "./endpointRegistry";
import { ValidationError } from "./errors";

/** Table/procedure names become URL path segments and endpoint-id fragments;
 * anything outside this is refused rather than risking a broken path
 * pattern or a surprising endpoint id. Real-world identifiers are practically
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
  tablesFound: number;
  proceduresFound: number;
  proceduresSupported: boolean;
  created: GeneratedEndpointSummary[];
  skipped: SkippedSummary[];
}

/**
 * Introspects `gatewayName` (must be kind: "sql") and generates endpoints for
 * every table (list / bulkCreate / bulkUpdate / bulkDelete) and, where the
 * dialect supports it, every stored procedure. Never overwrites or fails on
 * a conflict -- an id or method+path already in use (hand-written, or from
 * an earlier generation) is skipped and reported, so this is always safe to
 * re-run, e.g. after adding a table.
 */
export async function generateCrudEndpointsForGateway(
  gatewaysRegistry: GatewaysRegistry,
  endpointRegistry: EndpointRegistry,
  gatewayName: string
): Promise<GenerateCrudResult> {
  const resolved = gatewaysRegistry.getResolved().gateways[gatewayName];
  if (!resolved) {
    throw new ValidationError(`No gateway "${gatewayName}"`);
  }
  if (!("kind" in resolved) || resolved.kind !== "sql") {
    throw new ValidationError("Generating CRUD endpoints is only available for SQL/database gateways");
  }
  const sqlGw = resolved as SqlGatewayConfig;
  const introspection = await introspectSqlGateway(sqlGw);

  const created: GeneratedEndpointSummary[] = [];
  const skipped: SkippedSummary[] = [];

  const tables = [...introspection.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const table of tables) {
    generateTableEndpoints(endpointRegistry, gatewayName, table, created, skipped);
  }

  if (introspection.proceduresSupported) {
    const procedures = [...introspection.procedures].sort((a, b) => a.name.localeCompare(b.name));
    for (const proc of procedures) {
      generateProcedureEndpoint(endpointRegistry, gatewayName, proc, created, skipped);
    }
  }

  return {
    gateway: gatewayName,
    tablesFound: introspection.tables.length,
    proceduresFound: introspection.procedures.length,
    proceduresSupported: introspection.proceduresSupported,
    created,
    skipped,
  };
}

/** Attempts to persist one generated endpoint; on any conflict (id already in
 * use, or the same method+path claimed by a different id) records a skip
 * instead of throwing, so one conflict never aborts the whole generation. */
function tryUpsert(
  endpointRegistry: EndpointRegistry,
  endpointConfig: unknown,
  meta: { id: string; method: string; path: string },
  created: GeneratedEndpointSummary[],
  skipped: SkippedSummary[],
  kind: "table" | "procedure",
  name: string
): void {
  if (endpointRegistry.get(meta.id)) {
    skipped.push({ kind, name, reason: `endpoint id "${meta.id}" already exists` });
    return;
  }
  const pathConflict = endpointRegistry.list().find((r) => r.method === meta.method && r.path === meta.path);
  if (pathConflict) {
    skipped.push({
      kind,
      name,
      reason: `${meta.method} ${meta.path} is already used by endpoint "${pathConflict.id}"`,
    });
    return;
  }
  try {
    const { config } = endpointRegistry.upsert(endpointConfig);
    created.push({ id: config.id, method: config.method, path: config.path });
  } catch (err) {
    skipped.push({ kind, name, reason: err instanceof Error ? err.message : String(err) });
  }
}

function generateTableEndpoints(
  endpointRegistry: EndpointRegistry,
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
    endpointRegistry,
    {
      id: listId,
      description:
        `List/filter rows from "${table.name}". Query params: any column name for an exact-match filter, ` +
        `plus limit/offset/sort/order` +
        (pk.length === 1 ? `, and ids=v1,v2,... to fetch specific rows by ${pk[0]}.` : "."),
      method: "GET",
      path: basePath,
      input: [],
      backend: { type: "sql", gateway: gatewayName, table: table.name, operation: "list", primaryKey: pk, columns: columnNames },
      output: { root: "$[*]", fields: columnNames.map((c) => ({ target: c, source: `$.${c}` })) },
    },
    { id: listId, method: "GET", path: basePath },
    created,
    skipped,
    "table",
    table.name
  );

  const createId = `${gatewayName}-${table.name}-create`;
  tryUpsert(
    endpointRegistry,
    {
      id: createId,
      description: `Bulk-insert rows into "${table.name}". Body: { "rows": [ {...column values...}, ... ] }.`,
      method: "POST",
      path: basePath,
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
    endpointRegistry,
    {
      id: updateId,
      description:
        `Bulk-update rows in "${table.name}" by primary key [${pk.join(", ")}]. ` +
        `Body: { "updates": [ { "key": {...}, "fields": {...} }, ... ] }.`,
      method: "PATCH",
      path: basePath,
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
    endpointRegistry,
    {
      id: deleteId,
      description:
        `Bulk-delete rows from "${table.name}" by primary key [${pk.join(", ")}]. Body: { "keys": [ {...}, ... ] }.`,
      method: "DELETE",
      path: basePath,
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
  endpointRegistry: EndpointRegistry,
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
    endpointRegistry,
    {
      id,
      description: `Call stored procedure "${proc.name}"${proc.params.length ? ` with params: ${proc.params.join(", ")}` : ""}.`,
      method: "POST",
      path,
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
