import { z } from "zod";

export const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const inputParamSchema = z.object({
  name: z.string().min(1),
  in: z.enum(["path", "query", "header", "body", "env"]),
  // Only meaningful when `in: "env"`: which environment variable to read.
  // Falls back to `name` when omitted, so `{ name: "apiKey", in: "env" }"`
  // reads process.env.apiKey without repeating the name.
  envVar: z.string().min(1).optional(),
  required: z.boolean().optional().default(false),
  type: z.enum(["string", "number", "boolean"]).optional().default("string"),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
});

const jsonBackendSchema = z.object({
  type: z.literal("json"),
  gateway: z.string().optional(),
  url: z.string().min(1),
  method: httpMethodSchema.optional().default("GET"),
  headers: z.record(z.string()).optional(),
  query: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional().default(10000),
});

const xmlBackendSchema = z.object({
  type: z.literal("xml"),
  gateway: z.string().optional(),
  url: z.string().min(1),
  method: httpMethodSchema.optional().default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().optional().default(10000),
});

const soapBackendSchema = z.object({
  type: z.literal("soap"),
  gateway: z.string().optional(),
  // Optional here because the WSDL URL may instead come from the named
  // gateway (see the refinement below and src/connectors/soap.ts).
  wsdl: z.string().min(1).optional(),
  // Overrides the SOAP endpoint the operation is actually called against.
  // Many WSDLs declare a stale/internal <soap:address>; when omitted we
  // default to the WSDL URL with its query string stripped (the common
  // "service.svc?wsdl" -> "service.svc" convention).
  endpoint: z.string().optional(),
  operation: z.string().min(1),
  args: z.record(z.unknown()).optional().default({}),
  soapHeaders: z.array(z.record(z.unknown())).optional(),
  timeoutMs: z.number().int().positive().optional().default(15000),
});

const sqlCrudOperationSchema = z.enum(["list", "bulkCreate", "bulkUpdate", "bulkDelete"]);

const sqlBackendSchema = z.object({
  type: z.literal("sql"),
  gateway: z.string().min(1),
  // Raw-query mode (hand-written SQL with named :param bindings).
  query: z.string().min(1).optional(),
  // Generated table-CRUD mode (see src/server/crudGenerator.ts).
  table: z.string().min(1).optional(),
  operation: sqlCrudOperationSchema.optional(),
  primaryKey: z.array(z.string().min(1)).optional(),
  columns: z.array(z.string().min(1)).optional(),
  // Generated stored-procedure mode.
  procedure: z.string().min(1).optional(),
  procedureParams: z.array(z.string().min(1)).optional(),
});

export const backendSchema = z
  .discriminatedUnion("type", [jsonBackendSchema, xmlBackendSchema, soapBackendSchema, sqlBackendSchema])
  .superRefine((b, ctx) => {
    if (b.type === "soap" && !b.wsdl && !b.gateway) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wsdl"],
        message: "A SOAP backend needs either `wsdl` or a `gateway` that provides one",
      });
    }
    if (b.type === "sql") {
      const hasQuery = !!b.query;
      const hasTable = !!b.table || !!b.operation;
      const hasProcedure = !!b.procedure;
      const modeCount = [hasQuery, hasTable, hasProcedure].filter(Boolean).length;
      if (modeCount !== 1 || (hasTable && (!b.table || !b.operation))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["query"],
          message:
            "A SQL backend needs exactly one of: `query` (raw SQL), both `table` and `operation` " +
            "(generated table CRUD), or `procedure` (stored procedure call)",
        });
      }
      if (
        b.operation &&
        (b.operation === "bulkUpdate" || b.operation === "bulkDelete") &&
        (!b.primaryKey || b.primaryKey.length === 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["primaryKey"],
          message: `operation "${b.operation}" requires a non-empty \`primaryKey\` list`,
        });
      }
    }
  });

export const outputFieldSchema = z.object({
  target: z.string().min(1),
  source: z.string().min(1),
  default: z.unknown().optional(),
  transform: z
    .enum(["toString", "toNumber", "toBoolean", "trim", "upper", "lower"])
    .optional(),
});

export const outputSchema = z.object({
  root: z.string().optional(),
  fields: z.array(outputFieldSchema).min(1),
});

export const endpointConfigSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  method: httpMethodSchema,
  path: z.string().min(1).startsWith("/"),
  input: z.array(inputParamSchema).optional().default([]),
  backend: backendSchema,
  output: outputSchema,
});

export type EndpointConfigParsed = z.infer<typeof endpointConfigSchema>;

// Shared by every gateway kind: name -> value pairs that become
// available for {name} substitution in the backend config of every
// endpoint that uses this gateway, without each endpoint having to
// redeclare them. Values may reference ${env.X}, resolved the same way as
// any other gateway field. An endpoint's own `input` param of the same
// name wins if both are present (see connectors/index.ts).
const commonParamsField = { commonParams: z.record(z.string()).optional() };

const jsonGatewaySchema = z.object({
  kind: z.literal("json").optional(),
  baseUrl: z.string().min(1, "baseUrl is required"),
  headers: z.record(z.string()).optional(),
  ...commonParamsField,
});

const xmlGatewaySchema = z.object({
  kind: z.literal("xml").optional(),
  baseUrl: z.string().min(1, "baseUrl is required"),
  headers: z.record(z.string()).optional(),
  ...commonParamsField,
});

const soapGatewaySchema = z.object({
  kind: z.literal("soap").optional(),
  wsdl: z.string().min(1, "wsdl is required"),
  ...commonParamsField,
});

const sqlGatewaySchema = z.object({
  kind: z.literal("sql"),
  client: z.enum(["sqlite3", "pg", "mysql2", "mssql", "better-sqlite3"]),
  // NOTE: this nested `connection` field is knex's own required config
  // shape (host/user/password/database/filename, etc. -- whatever the
  // chosen `client` driver expects), NOT this project's named-gateway
  // concept. It keeps knex's own field name deliberately, even though the
  // gateway that CONTAINS it was renamed from "connection" to "gateway".
  connection: z.record(z.unknown()),
  useNullAsDefault: z.boolean().optional(),
  pool: z.record(z.unknown()).optional(),
  ...commonParamsField,
});

export const gatewayConfigSchema = z.union([
  sqlGatewaySchema,
  jsonGatewaySchema,
  xmlGatewaySchema,
  soapGatewaySchema,
]);

export const gatewaysFileSchema = z.object({
  gateways: z.record(gatewayConfigSchema).default({}),
});

export type GatewaysFileParsed = z.infer<typeof gatewaysFileSchema>;
