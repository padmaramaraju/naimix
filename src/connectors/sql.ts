import knex, { type Knex } from "knex";
import type { SqlBackendConfig, SqlGatewayConfig } from "../types/config";
import type { ConnectorContext, BackendResult } from "./types";
import { ValidationError } from "../server/errors";

// Keyed by "<gateway name>::<JSON of its resolved config>" rather than
// just the gateway name, so editing a gateway through the admin UI
// (different host/credentials/etc, same name) creates a fresh knex instance
// instead of silently reusing one built from the old config.
const knexCache = new Map<string, Knex>();

function getKnex(name: string, gw: SqlGatewayConfig): Knex {
  const cacheKey = `${name}::${JSON.stringify(gw)}`;
  let instance = knexCache.get(cacheKey);
  if (!instance) {
    // Drop any previous instance(s) registered under this gateway name
    // with a different config -- best-effort, we don't await the destroy.
    for (const [key, old] of knexCache) {
      if (key.startsWith(`${name}::`) && key !== cacheKey) {
        old.destroy().catch(() => undefined);
        knexCache.delete(key);
      }
    }
    instance = knex({
      client: gw.client,
      connection: gw.connection,
      useNullAsDefault:
        gw.useNullAsDefault ?? (gw.client === "sqlite3" || gw.client === "better-sqlite3"),
      pool: gw.pool as Knex.PoolConfig | undefined,
    });
    knexCache.set(cacheKey, instance);
  }
  return instance;
}

export async function closeAllSqlConnections(): Promise<void> {
  await Promise.all([...knexCache.values()].map((k) => k.destroy()));
  knexCache.clear();
}

/**
 * Opens a standalone knex instance for `gw` (deliberately NOT the shared
 * `knexCache`, since a test connection may be an in-progress edit that never
 * gets saved), runs a trivial query, and always tears it down again -- used
 * by the admin UI's "Test connection" button, not by any endpoint call.
 */
export async function testSqlConnection(
  gw: SqlGatewayConfig
): Promise<{ ok: true } | { ok: false; message: string }> {
  // knex/driver construction itself can throw synchronously for a bad config
  // (e.g. better-sqlite3 opening an unwritable path) -- keep it inside the
  // try too, so a bad "Test connection" click always resolves to {ok:false}
  // instead of an unhandled exception reaching the admin API as a 500.
  let db: Knex | undefined;
  try {
    db = knex({
      client: gw.client,
      connection: gw.connection,
      useNullAsDefault:
        gw.useNullAsDefault ?? (gw.client === "sqlite3" || gw.client === "better-sqlite3"),
      pool: gw.pool as Knex.PoolConfig | undefined,
    });
    await db.raw("select 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (db) await db.destroy().catch(() => undefined);
  }
}

export async function callSqlBackend(
  backend: SqlBackendConfig,
  ctx: ConnectorContext
): Promise<BackendResult> {
  const gw = ctx.gateways.gateways[backend.gateway];
  if (!gw || !("kind" in gw) || gw.kind !== "sql") {
    throw new Error(
      `Unknown or invalid SQL gateway "${backend.gateway}" referenced by SQL backend`
    );
  }
  const sqlGw = gw as SqlGatewayConfig;
  const db = getKnex(backend.gateway, sqlGw);

  if (backend.procedure) {
    ctx.logger.debug({ gateway: backend.gateway, procedure: backend.procedure }, "calling SQL procedure");
    return callStoredProcedure(db, sqlGw, backend, ctx);
  }

  if (backend.table && backend.operation) {
    ctx.logger.debug(
      { gateway: backend.gateway, table: backend.table, operation: backend.operation },
      "calling SQL table-CRUD backend"
    );
    switch (backend.operation) {
      case "list":
        return listRows(db, backend, ctx);
      case "bulkCreate":
        return bulkCreate(db, sqlGw, backend, ctx);
      case "bulkUpdate":
        return bulkUpdate(db, backend, ctx);
      case "bulkDelete":
        return bulkDelete(db, backend, ctx);
    }
  }

  ctx.logger.debug({ gateway: backend.gateway, query: backend.query }, "calling SQL backend");

  // knex.raw supports named bindings via the ":name" syntax when given an
  // object, so users write plain parameterized SQL in their endpoint config.
  const result = await db.raw(backend.query as string, ctx.params as Record<string, unknown>);
  return normalizeSqlResult(result);
}

/** Normalizes driver-specific raw-query result shapes to a plain array of rows. */
function normalizeSqlResult(result: unknown): unknown {
  if (Array.isArray(result)) return result; // mysql2-style [rows, fields]
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: unknown[] }).rows; // pg-style
  }
  return result;
}

// ---- Generated table-CRUD operations ----
// These back the endpoints created by the admin UI's "Generate CRUD endpoints"
// button (see src/server/crudGenerator.ts) -- they read straight from the
// caller's raw query string / JSON body rather than the declarative named
// `input` params every other endpoint type uses, since bulk operations need a
// whole array of rows/keys, not scalar values.

const RESERVED_LIST_QUERY_KEYS = new Set(["limit", "offset", "sort", "order", "ids"]);
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

async function listRows(db: Knex, backend: SqlBackendConfig, ctx: ConnectorContext): Promise<unknown> {
  const table = backend.table as string;
  const query = (ctx.rawQuery ?? {}) as Record<string, unknown>;
  const allowedColumns = new Set(backend.columns ?? []);

  let q = db(table);

  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_LIST_QUERY_KEYS.has(key) || !allowedColumns.has(key)) continue;
    q = q.andWhere(key, String(value));
  }

  if (typeof query.ids === "string" && backend.primaryKey?.length === 1) {
    const idList = query.ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (idList.length > 0) q = q.whereIn(backend.primaryKey[0], idList);
  }

  if (typeof query.sort === "string" && allowedColumns.has(query.sort)) {
    q = q.orderBy(query.sort, query.order === "desc" ? "desc" : "asc");
  }

  const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const offset = Math.max(Number(query.offset) || 0, 0);

  return q.limit(limit).offset(offset).select("*");
}

async function bulkCreate(
  db: Knex,
  gw: SqlGatewayConfig,
  backend: SqlBackendConfig,
  ctx: ConnectorContext
): Promise<unknown> {
  const table = backend.table as string;
  const body = (ctx.rawBody ?? {}) as Record<string, unknown>;
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError('Request body must be { "rows": [ {...}, ... ] } with at least one row');
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ValidationError('Each entry in "rows" must be an object of column values');
    }
  }

  // .returning() only works on pg/mssql via knex -- mysql2/sqlite silently
  // ignore it (or, for a multi-row insert, return only a partial insertId),
  // so only ask for it where it actually gives back full rows.
  const supportsReturning = gw.client === "pg" || gw.client === "mssql";
  if (supportsReturning) {
    const inserted = await db(table).insert(rows).returning("*");
    return { insertedCount: rows.length, rows: inserted };
  }
  await db(table).insert(rows);
  return { insertedCount: rows.length, rows: null };
}

interface KeyedResult {
  key: Record<string, unknown>;
  matched: number;
}

function validateKey(key: unknown, primaryKey: string[]): Record<string, unknown> {
  if (!key || typeof key !== "object" || Array.isArray(key)) {
    throw new ValidationError('Each entry needs a "key" object identifying the row by primary key');
  }
  const keyObj = key as Record<string, unknown>;
  const keyCols = Object.keys(keyObj);
  const missing = primaryKey.filter((c) => !keyCols.includes(c));
  const extra = keyCols.filter((c) => !primaryKey.includes(c));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`unexpected: ${extra.join(", ")}`);
    throw new ValidationError(
      `"key" must contain exactly the primary key column(s) [${primaryKey.join(", ")}] (${parts.join("; ")})`
    );
  }
  return keyObj;
}

async function bulkUpdate(db: Knex, backend: SqlBackendConfig, ctx: ConnectorContext): Promise<unknown> {
  const table = backend.table as string;
  const primaryKey = backend.primaryKey ?? [];
  const body = (ctx.rawBody ?? {}) as Record<string, unknown>;
  const updates = body.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new ValidationError(
      'Request body must be { "updates": [ { "key": {...}, "fields": {...} }, ... ] } with at least one entry'
    );
  }

  const results: KeyedResult[] = [];
  await db.transaction(async (trx) => {
    for (const entry of updates) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ValidationError('Each update entry must be an object with "key" and "fields"');
      }
      const { key, fields } = entry as { key?: unknown; fields?: unknown };
      const keyObj = validateKey(key, primaryKey);
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new ValidationError('Each update entry needs a "fields" object of columns to set');
      }
      const matched = await trx(table)
        .where(keyObj)
        .update(fields as Record<string, unknown>);
      results.push({ key: keyObj, matched });
    }
  });

  return { updatedCount: results.reduce((n, r) => n + r.matched, 0), results };
}

async function bulkDelete(db: Knex, backend: SqlBackendConfig, ctx: ConnectorContext): Promise<unknown> {
  const table = backend.table as string;
  const primaryKey = backend.primaryKey ?? [];
  const body = (ctx.rawBody ?? {}) as Record<string, unknown>;
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ValidationError('Request body must be { "keys": [ {...}, ... ] } with at least one key');
  }

  const results: KeyedResult[] = [];
  await db.transaction(async (trx) => {
    for (const key of keys) {
      const keyObj = validateKey(key, primaryKey);
      const matched = await trx(table).where(keyObj).delete();
      results.push({ key: keyObj, matched });
    }
  });

  return { deletedCount: results.reduce((n, r) => n + r.matched, 0), results };
}

// ---- Generated stored-procedure calls ----
// Unlike table-CRUD above, procedure args come through the normal declarative
// `input` pipeline (each generated as `in: "body"`), so ctx.params already
// holds them by name -- no rawBody needed here.

async function callStoredProcedure(
  db: Knex,
  gw: SqlGatewayConfig,
  backend: SqlBackendConfig,
  ctx: ConnectorContext
): Promise<unknown> {
  const procedure = backend.procedure as string;
  const paramNames = backend.procedureParams ?? Object.keys(ctx.params);
  const placeholders = paramNames.map((p) => `:${p}`).join(", ");

  let sql: string;
  switch (gw.client) {
    case "pg":
    case "mysql2":
      sql = `CALL ${procedure}(${placeholders})`;
      break;
    case "mssql":
      sql = `EXEC ${procedure} ${placeholders}`;
      break;
    case "sqlite3":
    case "better-sqlite3":
      throw new Error(`SQL client "${gw.client}" does not support stored procedures`);
    default: {
      const exhaustive: never = gw.client;
      throw new Error(`Unsupported SQL client: ${String(exhaustive)}`);
    }
  }

  const result = await db.raw(sql, ctx.params as Record<string, unknown>);
  return normalizeSqlResult(result);
}
