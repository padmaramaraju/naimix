// Shared TypeScript types for endpoint configs, gateways, and runtime context.
// The authoritative validation lives in src/config/schema.ts (zod); these
// types mirror it for use throughout the codebase.

export type InputLocation = "path" | "query" | "header" | "body" | "env";
export type InputType = "string" | "number" | "boolean";

export interface InputParamDef {
  name: string;
  in: InputLocation;
  /** Only meaningful when `in: "env"`; defaults to `name` when omitted. */
  envVar?: string;
  required?: boolean;
  type?: InputType;
  default?: string | number | boolean;
  description?: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface JsonBackendConfig {
  type: "json";
  gateway?: string;
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface XmlBackendConfig {
  type: "xml";
  gateway?: string;
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Request body as an XML string template. Supports {paramName} placeholders. */
  body?: string;
  timeoutMs?: number;
}

export interface SoapBackendConfig {
  type: "soap";
  gateway?: string;
  /** Optional when `gateway` supplies the WSDL URL instead. */
  wsdl?: string;
  /** Overrides the endpoint actually called; defaults to `wsdl` with its query string stripped. */
  endpoint?: string;
  operation: string;
  /** SOAP call arguments. Values may contain {paramName} placeholders. */
  args?: Record<string, unknown>;
  soapHeaders?: Record<string, unknown>[];
  timeoutMs?: number;
}

export type SqlCrudOperation = "list" | "bulkCreate" | "bulkUpdate" | "bulkDelete";

export interface SqlBackendConfig {
  type: "sql";
  gateway: string;
  /** Raw-query mode: SQL with named bind params, e.g. "SELECT * FROM t WHERE id = :id" */
  query?: string;
  /** Generated table-CRUD mode: the table this backend operates on. */
  table?: string;
  /** Generated table-CRUD mode: which operation this backend performs. */
  operation?: SqlCrudOperation;
  /** Ordered primary-key column name(s) for `table`. Required for bulkUpdate/bulkDelete
   * (each request identifies rows by supplying exactly these columns as a "key" object). */
  primaryKey?: string[];
  /** Whitelist of real column names on `table`, used by the `list` operation to decide
   * which query-string keys are safe to apply as exact-match filters. */
  columns?: string[];
  /** Generated stored-procedure mode: the procedure to call. */
  procedure?: string;
  /** Ordered parameter names for `procedure`, matching its declared signature. */
  procedureParams?: string[];
}

export type BackendConfig =
  | JsonBackendConfig
  | XmlBackendConfig
  | SoapBackendConfig
  | SqlBackendConfig;

export type FieldTransform =
  | "toString"
  | "toNumber"
  | "toBoolean"
  | "trim"
  | "upper"
  | "lower";

export interface OutputFieldDef {
  /** Dot-path in the output JSON, e.g. "name.first" or "tags[0]" */
  target: string;
  /** JSONPath into the (per-item) backend response, e.g. "$.firstName" */
  source: string;
  default?: unknown;
  transform?: FieldTransform;
}

export interface OutputConfig {
  /**
   * Optional JSONPath selecting an array of items in the backend response.
   * When set, the endpoint returns a JSON array and each `fields[].source`
   * is evaluated relative to each item. When omitted, the endpoint returns
   * a single JSON object and sources are evaluated against the whole
   * response.
   */
  root?: string;
  fields: OutputFieldDef[];
}

export interface EndpointConfig {
  id: string;
  description?: string;
  method: HttpMethod;
  path: string;
  input?: InputParamDef[];
  backend: BackendConfig;
  output: OutputConfig;
}

export interface JsonGatewayConfig {
  kind?: "json";
  baseUrl: string;
  headers?: Record<string, string>;
  /** Available as {name} to every endpoint using this gateway. */
  commonParams?: Record<string, string>;
}

export interface XmlGatewayConfig {
  kind?: "xml";
  baseUrl: string;
  headers?: Record<string, string>;
  commonParams?: Record<string, string>;
}

export interface SoapGatewayConfig {
  kind?: "soap";
  wsdl: string;
  commonParams?: Record<string, string>;
}

export interface SqlGatewayConfig {
  kind: "sql";
  client: "sqlite3" | "pg" | "mysql2" | "mssql" | "better-sqlite3";
  /** knex's own required config shape -- kept as "connection" deliberately
   * (see the matching note in src/config/schema.ts). */
  connection: Record<string, unknown>;
  useNullAsDefault?: boolean;
  pool?: Record<string, unknown>;
  commonParams?: Record<string, string>;
}

export type GatewayConfig =
  | JsonGatewayConfig
  | XmlGatewayConfig
  | SoapGatewayConfig
  | SqlGatewayConfig;

export interface GatewaysFile {
  gateways: Record<string, GatewayConfig>;
}
