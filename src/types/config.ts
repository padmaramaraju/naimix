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
  /** Name of an authProviders entry. When set, every endpoint calling
   * through this gateway requires a valid `Authorization: Bearer <token>`
   * session token issued by that provider (see POST /auth/login/{name}) --
   * the middleware resolves it to the real backend token and injects it as
   * {__authToken} before the request goes out. See AUTH_DESIGN_NOTES.md. */
  requiresAuth?: string;
}

export interface XmlGatewayConfig {
  kind?: "xml";
  baseUrl: string;
  headers?: Record<string, string>;
  commonParams?: Record<string, string>;
  requiresAuth?: string;
}

export interface SoapGatewayConfig {
  kind?: "soap";
  wsdl: string;
  commonParams?: Record<string, string>;
  requiresAuth?: string;
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
  requiresAuth?: string;
}

export type GatewayConfig =
  | JsonGatewayConfig
  | XmlGatewayConfig
  | SoapGatewayConfig
  | SqlGatewayConfig;

export interface GatewaysFile {
  gateways: Record<string, GatewayConfig>;
}

// ---- Auth providers ----
// See AUTH_DESIGN_NOTES.md for the full design. Each provider turns
// caller-supplied credentials into a backend token; the middleware stores
// that token server-side and hands the caller back its own opaque session
// token instead (see src/auth/).

/** Generic "POST credentials, extract a token from the JSON response"
 * provider for backends with their own bespoke login API (not a standard
 * OAuth2 token endpoint -- see OAuth2ProviderConfig for that). Field paths
 * are JSONPath expressions evaluated against the login response, reusing
 * the same extraction engine as an endpoint's `output.fields`. */
export interface BasicLoginProviderConfig {
  kind: "basicLogin";
  loginUrl: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Field names the caller's username/password are sent under in the JSON
   * request body. Default "username"/"password". */
  usernameField?: string;
  passwordField?: string;
  /** Extra static fields merged into every login request body (e.g. a
   * shared API key some backends require alongside user credentials). */
  staticFields?: Record<string, string>;
  /** JSONPath to the backend token in the login response (required). */
  tokenPath: string;
  /** JSONPath to a refresh token in the login response, if the backend
   * issues one. Captured into the session, but this provider doesn't
   * implement automatic refresh in phase 1 -- an expired session with no
   * refresh support just means a clean re-login. */
  refreshTokenPath?: string;
  /** JSONPath to a seconds-until-expiry value in the login response. */
  expiresInPath?: string;
  /** JSONPath to a caller-identifying subject/username in the response. */
  subjectPath?: string;
  /** Named claims to capture from the login response into the session
   * (reuses the same shape as an endpoint's output.fields). Captured for
   * future use; not yet exposed to backend param substitution. */
  claims?: OutputFieldDef[];
}

/** A standard OAuth2 token endpoint (RFC 6749) -- password grant (an end
 * user's own credentials) or client_credentials grant (this middleware
 * authenticating as itself, no end user involved). Request/response field
 * names follow the spec, so unlike BasicLoginProviderConfig there's nothing
 * to configure there. Supports the standard refresh_token grant when the
 * token response includes one. */
export interface OAuth2ProviderConfig {
  kind: "oauth2";
  tokenUrl: string;
  grantType: "password" | "client_credentials";
  clientId: string;
  clientSecret: string;
  scope?: string;
  headers?: Record<string, string>;
  /** Named claims to capture from the raw token response into the session. */
  claims?: OutputFieldDef[];
}

/** LDAP/AD plain simple-bind provider (step 2 of AUTH_DESIGN_NOTES.md's phased
 * build order). Supports two mutually-exclusive ways of finding the DN to
 * bind as -- exactly one must be fully configured (enforced in
 * src/config/schema.ts, since it's a cross-field rule a discriminated union
 * member can't express on its own):
 *
 *  - Direct bind: `userDnTemplate` with a predictable DN shape.
 *  - Search-then-bind: a service account (`bindDn`/`bindPassword`) searches
 *    (`searchBase`/`searchFilter`) for the real user DN, then binds as that
 *    DN with the caller's own password. This is the realistic pattern for
 *    Active Directory and most enterprise directories, where usernames don't
 *    map predictably to DNs.
 *
 * LDAP/AD has no native token to relay to backends, so the middleware mints
 * its own signed JWT as the stand-in "backend token" (see
 * AUTH_DESIGN_NOTES.md) -- any backend that separately trusts this
 * middleware (i.e. holds the same `tokenSecret`) can verify it. */
export interface LdapProviderConfig {
  kind: "ldap";
  /** e.g. "ldap://localhost:3389" or "ldaps://ad.example.com:636" */
  url: string;
  /** Only meaningful for ldaps:// URLs. Default true (verify the server's
   * TLS certificate); set false only for trusted internal test directories
   * with self-signed certs. */
  tlsRejectUnauthorized?: boolean;
  /** Direct-bind mode: a DN template with a {username} placeholder, e.g.
   * "uid={username},ou=people,dc=naimix,dc=test". The substituted username
   * is RFC 4514 value-escaped. */
  userDnTemplate?: string;
  /** Search-then-bind mode: service-account DN used to search for the real
   * user DN before binding as that user. */
  bindDn?: string;
  bindPassword?: string;
  /** Search-then-bind mode: base DN to search under, e.g.
   * "ou=people,dc=naimix,dc=test". */
  searchBase?: string;
  /** Search-then-bind mode: filter with a {username} placeholder, e.g.
   * "(uid={username})" (or "(sAMAccountName={username})" for AD). The
   * substituted value is LDAP-filter-escaped. */
  searchFilter?: string;
  /** Optional group-membership lookup, run after a successful bind. Base DN
   * to search under, e.g. "ou=groups,dc=naimix,dc=test". Omit to skip group
   * lookup entirely. */
  groupSearchBase?: string;
  /** Filter with {dn} and/or {username} placeholders, e.g. "(member={dn})".
   * Required when `groupSearchBase` is set. */
  groupSearchFilter?: string;
  /** Attribute holding each matched group's display name. Default "cn". */
  groupNameAttribute?: string;
  /** Extra directory attributes to capture off the resolved user entry into
   * claims.attributes, e.g. ["mail", "title", "departmentNumber"]. */
  attributes?: string[];
  /** Secret used to sign the stand-in backend JWT. Typically an ${env.X}
   * reference, never a literal secret in committed config. */
  tokenSecret: string;
  /** Seconds until the minted JWT (and the session) expires. Default 3600. */
  tokenTtlSeconds?: number;
}

export type AuthProviderConfig =
  | BasicLoginProviderConfig
  | OAuth2ProviderConfig
  | LdapProviderConfig;

export interface AuthProvidersFile {
  authProviders: Record<string, AuthProviderConfig>;
}
