import knex, { type Knex } from "knex";
import type { SqlGatewayConfig } from "../types/config";

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  /** Ordered primary-key column name(s); empty if the table has none. */
  primaryKey: string[];
}

export interface IntrospectedProcedure {
  name: string;
  /** Ordered parameter names, as declared by the procedure's own signature. */
  params: string[];
}

export interface SqlIntrospection {
  tables: IntrospectedTable[];
  procedures: IntrospectedProcedure[];
  /** False for sqlite3/better-sqlite3 -- neither has a stored-procedure concept. */
  proceduresSupported: boolean;
}

/**
 * Opens a standalone knex instance (same pattern as testSqlConnection in
 * sql.ts -- deliberately NOT the shared knexCache, and always torn down
 * afterward) and discovers every user table (with its columns and primary
 * key) plus, where the dialect supports it, every stored procedure (with
 * its parameter names). This is the raw material src/server/crudGenerator.ts
 * turns into actual endpoint configs.
 */
export async function introspectSqlGateway(gw: SqlGatewayConfig): Promise<SqlIntrospection> {
  const db = knex({
    client: gw.client,
    connection: gw.connection,
    useNullAsDefault: gw.useNullAsDefault ?? (gw.client === "sqlite3" || gw.client === "better-sqlite3"),
    pool: gw.pool as Knex.PoolConfig | undefined,
  });
  try {
    switch (gw.client) {
      case "sqlite3":
      case "better-sqlite3":
        return await introspectSqlite(db);
      case "pg":
        return await introspectPg(db);
      case "mysql2":
        return await introspectMysql(db);
      case "mssql":
        return await introspectMssql(db);
      default: {
        const exhaustive: never = gw.client;
        throw new Error(`Unsupported SQL client: ${String(exhaustive)}`);
      }
    }
  } finally {
    await db.destroy().catch(() => undefined);
  }
}

// ---- SQLite / better-sqlite3 ----
// No information_schema and no stored procedures at all; table/column/PK
// info comes from sqlite_master + PRAGMA table_info.

async function introspectSqlite(db: Knex): Promise<SqlIntrospection> {
  const tableRows = (await db("sqlite_master")
    .select("name")
    .where("type", "table")
    .andWhere("name", "not like", "sqlite_%")
    .andWhere("name", "not like", "knex_%")) as { name: string }[];

  const tables: IntrospectedTable[] = [];
  for (const { name } of tableRows) {
    const info = (await db.raw("PRAGMA table_info(??)", [name])) as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    const columns = info.map((c) => ({ name: c.name, dataType: c.type || "TEXT", nullable: c.notnull === 0 }));
    const primaryKey = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    tables.push({ name, columns, primaryKey });
  }

  return { tables, procedures: [], proceduresSupported: false };
}

// ---- PostgreSQL ----
//
// Every information_schema query below explicitly ALIASES each selected
// column to a lowercase name of our own choosing (`.select({ alias: "real
// column" })`), rather than trusting the driver to hand back a JS object key
// that matches how we wrote the query. An explicit AS alias is guaranteed by
// the SQL standard to control the result set's field name outright, whereas
// an *unaliased* information_schema column's reported name-casing is a
// long-standing cross-database (and even cross-version) inconsistency --
// this is what a real MySQL server hit in practice (see project memory):
// the unaliased column query came back keyed however that server's
// information_schema implementation names it, not necessarily lowercase
// "table_name" as written, leaving `table_name` `undefined` in JS and
// tripping knex's "Undefined binding(s) detected" safety check on the next
// query. Aliasing everywhere closes off this whole class of bug rather than
// patching the one column that happened to get reported.

async function introspectPg(db: Knex): Promise<SqlIntrospection> {
  const tableRows = (await db("information_schema.tables")
    .select({ table_name: "table_name" })
    .where("table_schema", "public")
    .andWhere("table_type", "BASE TABLE")) as { table_name: string }[];

  const tables: IntrospectedTable[] = [];
  for (const { table_name } of tableRows) {
    const columnRows = (await db("information_schema.columns")
      .select({ column_name: "column_name", data_type: "data_type", is_nullable: "is_nullable" })
      .where("table_schema", "public")
      .andWhere("table_name", table_name)
      .orderBy("ordinal_position")) as { column_name: string; data_type: string; is_nullable: string }[];

    const pkRows = (await db("information_schema.table_constraints as tc")
      .join("information_schema.key_column_usage as kcu", function join() {
        this.on("tc.constraint_name", "=", "kcu.constraint_name").andOn("tc.table_schema", "=", "kcu.table_schema");
      })
      .where("tc.constraint_type", "PRIMARY KEY")
      .andWhere("tc.table_schema", "public")
      .andWhere("tc.table_name", table_name)
      .orderBy("kcu.ordinal_position")
      .select({ column_name: "kcu.column_name" })) as { column_name: string }[];

    tables.push({
      name: table_name,
      columns: columnRows.map((c) => ({
        name: c.column_name,
        dataType: c.data_type,
        nullable: c.is_nullable === "YES",
      })),
      primaryKey: pkRows.map((r) => r.column_name),
    });
  }

  const procRows = (await db("information_schema.routines")
    .select({ routine_name: "routine_name", specific_name: "specific_name" })
    .where("routine_schema", "public")
    .andWhere("routine_type", "PROCEDURE")) as { routine_name: string; specific_name: string }[];

  const procedures: IntrospectedProcedure[] = [];
  for (const { routine_name, specific_name } of procRows) {
    const paramRows = (await db("information_schema.parameters")
      .select({ parameter_name: "parameter_name" })
      .where("specific_schema", "public")
      .andWhere("specific_name", specific_name)
      .whereNotNull("parameter_name")
      .orderBy("ordinal_position")) as { parameter_name: string }[];
    procedures.push({ name: routine_name, params: paramRows.map((p) => p.parameter_name) });
  }

  return { tables, procedures, proceduresSupported: true };
}

// ---- MySQL / MariaDB ----

async function introspectMysql(db: Knex): Promise<SqlIntrospection> {
  const tableRows = (await db("information_schema.tables")
    .select({ table_name: "table_name" })
    .whereRaw("table_schema = database()")
    .andWhere("table_type", "BASE TABLE")) as { table_name: string }[];

  const tables: IntrospectedTable[] = [];
  for (const { table_name } of tableRows) {
    const columnRows = (await db("information_schema.columns")
      .select({ column_name: "column_name", data_type: "data_type", is_nullable: "is_nullable" })
      .whereRaw("table_schema = database()")
      .andWhere("table_name", table_name)
      .orderBy("ordinal_position")) as { column_name: string; data_type: string; is_nullable: string }[];

    const pkRows = (await db("information_schema.key_column_usage")
      .select({ column_name: "column_name" })
      .whereRaw("table_schema = database()")
      .andWhere("table_name", table_name)
      .andWhere("constraint_name", "PRIMARY")
      .orderBy("ordinal_position")) as { column_name: string }[];

    tables.push({
      name: table_name,
      columns: columnRows.map((c) => ({
        name: c.column_name,
        dataType: c.data_type,
        nullable: c.is_nullable === "YES",
      })),
      primaryKey: pkRows.map((r) => r.column_name),
    });
  }

  const procRows = (await db("information_schema.routines")
    .select({ routine_name: "routine_name", specific_name: "specific_name" })
    .whereRaw("routine_schema = database()")
    .andWhere("routine_type", "PROCEDURE")) as { routine_name: string; specific_name: string }[];

  const procedures: IntrospectedProcedure[] = [];
  for (const { routine_name, specific_name } of procRows) {
    const paramRows = (await db("information_schema.parameters")
      .select({ parameter_name: "parameter_name" })
      .whereRaw("specific_schema = database()")
      .andWhere("specific_name", specific_name)
      .whereNotNull("parameter_name")
      .orderBy("ordinal_position")) as { parameter_name: string }[];
    procedures.push({ name: routine_name, params: paramRows.map((p) => p.parameter_name) });
  }

  return { tables, procedures, proceduresSupported: true };
}

// ---- Microsoft SQL Server ----

async function introspectMssql(db: Knex): Promise<SqlIntrospection> {
  const tableRows = (await db("INFORMATION_SCHEMA.TABLES")
    .select({ table_name: "TABLE_NAME" })
    .where("TABLE_TYPE", "BASE TABLE")) as { table_name: string }[];

  const tables: IntrospectedTable[] = [];
  for (const { table_name: tableName } of tableRows) {
    const columnRows = (await db("INFORMATION_SCHEMA.COLUMNS")
      .select({ column_name: "COLUMN_NAME", data_type: "DATA_TYPE", is_nullable: "IS_NULLABLE" })
      .where("TABLE_NAME", tableName)
      .orderBy("ORDINAL_POSITION")) as { column_name: string; data_type: string; is_nullable: string }[];

    const pkRows = (await db("INFORMATION_SCHEMA.TABLE_CONSTRAINTS as tc")
      .join("INFORMATION_SCHEMA.KEY_COLUMN_USAGE as kcu", "tc.CONSTRAINT_NAME", "kcu.CONSTRAINT_NAME")
      .where("tc.CONSTRAINT_TYPE", "PRIMARY KEY")
      .andWhere("tc.TABLE_NAME", tableName)
      .orderBy("kcu.ORDINAL_POSITION")
      .select({ column_name: "kcu.COLUMN_NAME" })) as { column_name: string }[];

    tables.push({
      name: tableName,
      columns: columnRows.map((c) => ({
        name: c.column_name,
        dataType: c.data_type,
        nullable: c.is_nullable === "YES",
      })),
      primaryKey: pkRows.map((r) => r.column_name),
    });
  }

  const procRows = (await db("INFORMATION_SCHEMA.ROUTINES")
    .select({ routine_name: "ROUTINE_NAME", specific_name: "SPECIFIC_NAME" })
    .where("ROUTINE_TYPE", "PROCEDURE")) as { routine_name: string; specific_name: string }[];

  const procedures: IntrospectedProcedure[] = [];
  for (const { routine_name: routineName, specific_name: specificName } of procRows) {
    const paramRows = (await db("INFORMATION_SCHEMA.PARAMETERS")
      .select({ parameter_name: "PARAMETER_NAME" })
      .where("SPECIFIC_NAME", specificName)
      .whereNotNull("PARAMETER_NAME")
      .orderBy("ORDINAL_POSITION")) as { parameter_name: string }[];
    // MSSQL parameter names are declared with a leading "@" (e.g. "@customerId");
    // strip it so the generated endpoint's input param names read naturally.
    procedures.push({
      name: routineName,
      params: paramRows.map((p) => p.parameter_name.replace(/^@/, "")),
    });
  }

  return { tables, procedures, proceduresSupported: true };
}
