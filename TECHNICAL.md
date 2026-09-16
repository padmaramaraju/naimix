# Naimix — Technical Documentation

This is the internals reference for `naimix`: how the system is actually built, why it's
built that way, and a running log of every enhancement and fix made to it. It's meant to be
self-contained — a developer picking up this codebase should be able to work from this file alone,
without also needing `README.md` open.

`README.md` is the companion document and covers the same ground from a different angle: it's the
*user-facing* guide (install it, configure an endpoint, run the admin UI) aimed at someone operating the
middleware. This file is aimed at someone *modifying* it — the actual module boundaries, request flow,
data structures, and the reasoning behind non-obvious decisions.

**This document is a living artifact.** Every time a feature is added or a bug is fixed in this
project, the corresponding section below is updated and a dated entry is added to the
[Changelog](#changelog) at the bottom. If you're reading this and just shipped a change that isn't
reflected here yet, that's a bug in the process — fix the doc in the same pass as the code.

## Table of contents

1. [System overview](#system-overview)
2. [Project structure](#project-structure)
3. [Request lifecycle](#request-lifecycle)
4. [Configuration system](#configuration-system)
   - [Endpoint config reference](#endpoint-config-reference)
   - [Gateway config reference](#gateway-config-reference)
   - [Environment variable substitution](#environment-variable-substitution)
   - [Hot-reloadable registries](#hot-reloadable-registries)
   - [Folder layout mirrors each endpoint's path](#folder-layout-mirrors-each-endpoints-path)
   - [Workspace](#workspace)
5. [Backend connectors](#backend-connectors)
   - [JSON connector](#json-connector)
   - [XML connector](#xml-connector)
   - [SOAP connector](#soap-connector)
   - [SQL connector](#sql-connector)
6. [Auto-generated CRUD + stored-procedure endpoints](#auto-generated-crud--stored-procedure-endpoints)
7. [Output mapping engine](#output-mapping-engine)
8. [Admin UI and Admin API](#admin-ui-and-admin-api)
9. [Environment variables reference](#environment-variables-reference)
10. [Testing strategy](#testing-strategy)
11. [Runtime requirements and dependencies](#runtime-requirements-and-dependencies) (see also [`TECH_STACK.md`](TECH_STACK.md) for *why* each one was picked)
12. [Known limitations](#known-limitations)
13. [Changelog](#changelog)

## System overview

Lohitas Middleware is a Node.js/TypeScript server that sits in front of heterogeneous backends —
JSON REST APIs, generic XML-over-HTTP APIs, SOAP services, and SQL databases — and exposes them as a
uniform JSON API, driven entirely by declarative config rather than hand-written per-endpoint code.
An "endpoint" config describes: where the data comes from (a *backend*, referencing a named
*gateway*), what input parameters the caller supplies, and how the raw backend response maps into
the JSON shape the caller actually gets back.

Design principles that show up repeatedly in the codebase:

- **Config over code.** Adding an endpoint means writing an endpoint file, not writing a request handler.
  This is why the schema (`src/config/schema.ts`) is the real API surface of the project — the code
  underneath is generic machinery that interprets it.
- **Hot reload, always.** Every mutation made through the admin API (create/edit/delete an endpoint or
  gateway) takes effect on the very next HTTP request, no restart. This shaped the server's
  architecture from the start: endpoints are matched by one dynamic dispatcher reading an in-memory
  table, not by registering individual Express handlers at startup.
- **One backend abstraction, five SQL dialects.** The SQL connector uses `knex` as a dialect-agnostic
  query builder so the same endpoint config shape (and the same generated-CRUD feature) works whether the
  underlying database is Postgres, MySQL, SQL Server, or SQLite.
- **Fail loud, fail specific.** Zod schemas validate every config file and every admin API request
  body; validation errors carry a field path so the admin UI (and a developer editing YAML by hand)
  gets a precise, actionable message instead of "invalid input".
- **Everything the admin UI can do, `curl` can do too.** The admin UI is a thin browser client over
  `/admin/api/*` — there's no functionality that exists only in the UI and not the API.

## Project structure

```
src/
  config/
    schema.ts        zod schemas for endpoint configs, gateway configs, and their sub-shapes.
                      This IS the authoritative definition of what's valid config.
    loader.ts         Reads YAML/JSON files off disk (recursively) into parsed config objects.
    envSubst.ts       Resolves ${env.VAR_NAME} placeholders anywhere in a config value.
  types/
    config.ts         Plain TypeScript interfaces mirroring schema.ts, for use outside zod-aware code.
  connectors/
    index.ts          callBackend() -- dispatches to the right connector by backend.type, and layers
                       a gateway's commonParams under the endpoint's own resolved params.
    json.ts           JSON REST backend (axios).
    xml.ts             Generic XML-over-HTTP backend (axios + fast-xml-parser).
    soap.ts           SOAP backend (the `soap` npm client), with per-WSDL client caching.
    sql.ts            SQL backend: raw queries, generated table-CRUD, generated stored-procedure
                       calls, and the knex-instance/connection-pool cache.
    sqlIntrospect.ts  Discovers a SQL gateway's tables/columns/primary-keys/procedures, per dialect.
    paramSubst.ts     Resolves {paramName} placeholders inside backend config values, per-request.
    types.ts          ConnectorContext / BackendResult shared types.
  transform/
    mapper.ts         Applies an endpoint's declarative `output` config (JSONPath in, dot-path out) to a
                       raw backend response.
  server/
    index.ts          Process entry point: resolves which workspace to start from (persisted
                       setting > CONFIG_DIR > legacy ENDPOINTS_DIR/GATEWAYS_FILE), builds the
                       registries, builds the Express app, listens, handles graceful shutdown.
    app.ts            Builds the Express app: static admin UI, admin API (behind auth), the dynamic
                       endpoint dispatcher, 404 handler, centralized error handler.
    dispatch.ts       The single Express middleware that serves every configured endpoint.
    endpointRegistry.ts  In-memory table of endpoint configs, backed by files under a (mutable, repointable)
                       endpoints directory, with hot create/update/delete.
    endpointFileLayout.ts Computes where an endpoint's config file belongs on disk (folder structure mirrors
                       its URL path).
    gatewaysRegistry.ts  In-memory table of named gateways, backed by a (mutable, repointable)
                       gateways.yaml, with redaction and hot create/update/delete.
    workspaceSettings.ts  "Which workspace is this instance pointed at" -- resolves a folder into
                       {endpointsDir, gatewaysFile}, and persists/reads the admin-UI-chosen workspace to/
                       from a local settings file so it survives a restart. See Workspace.
    crudGenerator.ts  Generates table-CRUD + stored-procedure endpoints for a SQL gateway.
    paramExtractor.ts Extracts+validates an endpoint's declared `input` params from an incoming request.
    adminApi.ts       The /admin/api/* REST API.
    adminAuth.ts      Bearer-token auth gate in front of the admin API.
    errors.ts         ValidationError (400) / BackendError (502 by default) error classes.
    logger.ts         pino logger setup.
  mock-backend/
    index.ts          Standalone demo backend exposing the same dataset as JSON + XML + SOAP, used
                       for local dev (`npm run mock-backend`) and as the automated-test fixture.
    data.ts           The shared demo dataset (3 customers).
    seedDb.ts         Seeds a SQLite file with that dataset (customers, notes, tags tables) for the
                       SQL backend example and for CRUD-generation test coverage.
    customerService.wsdl  Hand-written WSDL for the mock SOAP service.

public/admin/         The admin UI: plain HTML/CSS/JS, no build step, served via express.static.
  index.html          Markup: login screen, Endpoints/Gateways tabs, endpoint editor drawer, gateway
                       editor drawer.
  admin.js            All client-side logic (~950 lines): API calls, the endpoints folder-tree renderer,
                       the endpoint/gateway editors, key-value editors, path auto-generation, the
                       "Try it" test panel.
  admin.css           Styling, incl. light/dark via prefers-color-scheme.

config/
  endpoints/             One YAML file per endpoint, nested into folders mirroring each endpoint's own path
                       (see "Folder layout mirrors each endpoint's path" below).
  gateways.yaml    Named backend gateways (URLs, WSDLs, DB credentials -- via ${env.X}).

test/
  middleware.test.ts  Integration tests: every backend type end-to-end against the mock backend, the
                       full admin API (endpoint/gateway CRUD, test endpoints, connection pooling
                       edge cases, CRUD generation, folder-layout behavior).
  mapper.test.ts      Unit tests for the output-mapping engine.
  paramExtractor.test.ts  Unit tests for input-param extraction/coercion/validation.
```

## Request lifecycle

For a live (non-admin) request, e.g. `GET /api/json/customers/1`:

1. **`app.ts`** has already registered, in order: `express.json()`/`express.urlencoded()` body
   parsing, `/healthz`, `/__endpoints`, `express.static` for `/admin`, the auth-gated `/admin/api`
   router, and finally `createDynamicDispatcher(...)` as a catch-all middleware.
2. **`dispatch.ts`**'s dispatcher runs `endpointRegistry.match(req.method, req.path)`. `EndpointRegistry`
   holds every loaded endpoint wrapped with a `path-to-regexp` matcher; the first endpoint whose method and
   path pattern match wins (registration order is insertion order into the underlying `Map`, which is
   file-load order at startup or creation order for anything added later). If nothing matches, `next()`
   falls through to the 404 handler.
3. **`paramExtractor.ts`**'s `extractParams()` walks the matched endpoint's declared `input` array,
   pulling each param from `req.params` (path), `req.query`, `req.headers` (lower-cased), `req.body`,
   or `process.env` (for `in: "env"`), applying `required`/`default`/type coercion, and throwing a
   `ValidationError` (400) for anything that fails.
4. **`connectors/index.ts`**'s `callBackend()` looks at `endpoint.backend.type`, layers the referenced
   gateway's `commonParams` underneath the extracted params (the endpoint's own params win on a name
   collision), and dispatches to the matching connector module (`json.ts`/`xml.ts`/`soap.ts`/`sql.ts`).
5. **The connector** resolves `{paramName}` placeholders in its own config (URL, headers, SOAP args,
   XML body template — via `paramSubst.ts`), calls the real backend, and returns a plain JS
   value (object or array) — no endpoint-specific knowledge lives in the connector layer.
6. **`transform/mapper.ts`**'s `mapResponse()` applies the endpoint's `output` config: if `output.root` is
   set, it's a JSONPath selecting an array, and every field's JSONPath `source` is evaluated once per
   item; otherwise the whole response is mapped once into a single object.
7. **`dispatch.ts`** sends the mapped result as JSON. Any thrown error (`ValidationError`,
   `BackendError`, or an unexpected exception wrapped as a 502) is passed to `next(err)` and handled by
   `app.ts`'s centralized error handler, which logs it (`warn` for 4xx, `error` for 5xx) and responds
   with `{ error, message, backendBody? }`.

For an `/admin/api/*` request, the flow is the same Express app but a different router
(`adminApi.ts`), gated by `adminAuth.ts`'s bearer-token check, and acting directly on the
`EndpointRegistry`/`GatewaysRegistry` in memory (which is what makes changes take effect immediately —
there's no separate "reload" step required, though one exists for picking up hand-edited files).

## Configuration system

### Endpoint config reference

Every field below is validated by `endpointConfigSchema` in `src/config/schema.ts`.

```yaml
id: get-customer                 # unique id (used in logs, the admin UI, and as part of the filename)
description: "Optional human-readable description"
method: GET                      # GET | POST | PUT | PATCH | DELETE
path: /api/customers/:id         # must start with "/"; Express-style path, supports :params

input:                           # optional, defaults to []
  - name: id
    in: path                     # path | query | header | body | env
    required: true               # optional, defaults to false
    type: string                 # string | number | boolean, defaults to "string"
    default: someValue           # optional
    description: "..."           # optional, documentation only
    envVar: SOME_ENV_VAR         # only meaningful when in: env; defaults to `name` if omitted

backend:                         # discriminated union on `type` -- see below
  type: json
  ...

output:
  root: "$.items[*]"             # optional JSONPath selecting an array; omit for a single object
  fields:
    - target: name.first         # dot-path in the OUTPUT JSON (supports "tags[0]" array indices)
      source: "$.firstName"      # JSONPath into the (per-item) backend response
      default: "Unknown"         # optional, used when `source` has no match
      transform: trim            # optional: toString | toNumber | toBoolean | trim | upper | lower
```

**`input[].in: "env"`** is the one location not sourced from the caller's request at all —
`paramExtractor.ts` reads `process.env[envVar || name]` instead. This exists for endpoints that need a
value (e.g. a shared API key) the *caller* should never be able to set or see, only the operator via
the server's own environment.

**`backend`** is a Zod discriminated union on `type`, one of `json` | `xml` | `soap` | `sql`:

```yaml
# json
backend:
  type: json
  gateway: crmJson            # optional -- omit to give an absolute `url` with no named gateway
  url: /customers/{id}           # relative (joined to the gateway's baseUrl) or absolute; supports {param}
  method: GET                    # optional, defaults to GET
  headers: { X-Api-Key: "{apiKey}" }   # optional, merged over the gateway's own headers
  query: { status: "{status}" }  # optional, JSON backend only
  body: { ... }                  # optional, JSON backend only -- {param} placeholders resolved recursively
  timeoutMs: 10000               # optional, defaults to 10000

# xml -- same url/method/headers/timeoutMs shape as json, but:
backend:
  type: xml
  gateway: crmXml
  url: /customers/{id}/xml
  body: "<request><id>{id}</id></request>"   # optional XML string TEMPLATE (not a JSON object)

# soap
backend:
  type: soap
  gateway: crmSoap            # optional if `wsdl` given directly on the backend
  wsdl: https://.../Service.svc?wsdl   # optional if the gateway supplies one
  endpoint: https://.../Service.svc    # optional override; defaults to `wsdl` with its query string stripped
  operation: GetCustomer          # must match a `<operationName>Async` method on the generated soap client
  args: { CustomerId: "{id}" }    # optional, {param} placeholders resolved recursively
  soapHeaders: [ { ... } ]        # optional, each added via client.addSoapHeader()
  timeoutMs: 15000                # optional, defaults to 15000

# sql -- exactly ONE of the three modes below; see "SQL connector" for the generated modes' internals
backend:
  type: sql
  gateway: demoDb
  query: "SELECT * FROM customers WHERE id = :id"    # raw-query mode: named :param bindings

# OR (generated table-CRUD mode -- normally written by "Generate CRUD endpoints", not by hand)
backend:
  type: sql
  gateway: demoDb
  table: customers
  operation: list                 # list | bulkCreate | bulkUpdate | bulkDelete
  primaryKey: [id]                 # required for bulkUpdate/bulkDelete
  columns: [id, first_name, ...]  # used by `list` to whitelist safe query-string filter keys

# OR (generated stored-procedure mode)
backend:
  type: sql
  gateway: demoDb
  procedure: sp_get_customer
  procedureParams: [customerId]   # ordered, matching the procedure's own declared signature
```

The `sql` backend's three modes are mutually exclusive and enforced by a `superRefine` on
`backendSchema`: exactly one of `query`, (`table` **and** `operation`), or `procedure` must be present,
and `primaryKey` must be a non-empty array when `operation` is `bulkUpdate` or `bulkDelete`. A `soap`
backend also has a refinement requiring either its own `wsdl` or a `gateway` that supplies one.

**`output`** — `root` is optional; when present it's a JSONPath expression selecting an array in the
raw response, and the endpoint returns a JSON array with each element built independently from that
item. When `root` is omitted, the endpoint returns one JSON object built directly from the whole raw
response. Each `fields[]` entry: `source` (JSONPath, evaluated relative to the item or the whole
response) is read first; if it has no match, `default` is used instead; if a value was found (either
way), `transform` is applied; the final value is written into the output object at the dot-path
`target` (an index like `tags[0]` is treated as an array-index segment, auto-vivifying arrays/objects
as needed). A field whose value is `undefined` after all of this (no match and no default) is omitted
from the output entirely rather than written as `null`.

### Gateway config reference

Every field below is validated by `gatewayConfigSchema` (a `z.union`, not a discriminated union —
`kind` is optional on 3 of its 4 branches, which is why `parseGatewayConfig()` in
`gatewaysRegistry.ts` exists; see [Admin UI and Admin API](#admin-ui-and-admin-api)).

```yaml
gateways:
  crmJson:
    kind: json                    # optional (defaults to json-shaped inference), one of json|xml|soap|sql
    baseUrl: ${env.CRM_BASE_URL}  # REQUIRED, non-empty
    headers: { Authorization: "Bearer ${env.CRM_TOKEN}" }   # optional, merged under an endpoint's own headers
    commonParams: { region: us }  # optional, see below

  crmXml:
    kind: xml
    baseUrl: ${env.XML_BASE_URL}  # REQUIRED
    headers: { }                  # optional
    commonParams: { }             # optional

  crmSoap:
    kind: soap
    wsdl: ${env.SOAP_WSDL_URL}    # REQUIRED
    commonParams: { }             # optional

  demoDb:
    kind: sql                     # REQUIRED for sql (it's the only branch where `kind` is mandatory,
                                    # since it's the only way to disambiguate an otherwise-empty-looking
                                    # gateway object from json/xml/soap)
    client: better-sqlite3        # REQUIRED: sqlite3 | pg | mysql2 | mssql | better-sqlite3
    connection: { filename: ${env.DEMO_SQLITE_PATH} }   # REQUIRED, passed straight to knex
    useNullAsDefault: true        # optional; auto-defaults to true for sqlite3/better-sqlite3
    pool: { min: 2, max: 10 }     # optional, passed straight to knex's pool config -- see SQL connector
    commonParams: { }             # optional
```

**`commonParams`** (any gateway kind): a flat `Record<string,string>` merged into every endpoint
call's resolved params, as the *lower*-precedence layer — `{...commonParams, ...endpointParams}` in
`connectors/index.ts`'s `withGatewayCommonParams()`. An endpoint's own resolved input param (from the
request, or an `in: env` param) of the same name overrides the gateway default for that call only;
other endpoints on the same gateway keep getting the shared default. Useful for a value every endpoint on
a gateway should share (an API version header, a tenant id) without redeclaring it as an `input` on
every endpoint.

### Environment variable substitution

Any string value anywhere in an endpoint or gateway config may contain `${env.VAR_NAME}`, resolved by
`src/config/envSubst.ts`'s `substituteEnv()` — a straightforward recursive walk over
strings/arrays/objects, replacing every match against `process.env`. **Substitution happens once, at
config-load time** (not per-request) for anything going through `loadEndpointConfigs()`/`loadGateways()`
in `loader.ts`. If a referenced variable isn't set, it throws immediately rather than silently
resolving to `"undefined"` or an empty string — a missing secret fails loud at startup (or at
`GatewaysRegistry.upsert()`/save time through the admin API) instead of surfacing later as a
confusing runtime error from whatever backend call needed it. The admin UI's `GatewaysRegistry`
specifically keeps *both* the raw pre-substitution config and can produce the resolved version on
demand (`getResolved()`), so editing one field of a gateway never requires re-typing a secret, and
the UI can show "this references an environment variable" instead of ever displaying (or being able
to leak) the resolved value.

### Hot-reloadable registries

Two classes hold the live, mutable state the server actually runs on, replacing what would otherwise
be one-shot config loaded at startup:

- **`EndpointRegistry`** (`src/server/endpointRegistry.ts`) — a `Map<id, {config, file, matcher}>` backed by
  the files under its endpoints directory (`getDir()`). `reloadFromDisk()` re-reads everything (used at
  startup, and by `POST /admin/api/reload`); `upsert()`/`remove()` are what the admin API calls, and
  they mutate the in-memory map *and* the file on disk in the same call, so the very next request
  already sees the change. `match(method, path)` is what `dispatch.ts` calls per-request; it iterates
  the map in insertion order and returns the first `path-to-regexp` match. `setDir(endpointsDir)` repoints
  the registry at a different directory and reloads from it immediately — the endpoint half of "Change
  workspace" (see [Workspace](#workspace)).
- **`GatewaysRegistry`** (`src/server/gatewaysRegistry.ts`) — same idea for a
  `gateways.yaml` (`getFilePath()`), but as a single file with one entry per gateway name rather
  than one file per endpoint. Keeps the raw (pre-`${env.X}`) config for the admin UI and produces the
  resolved version (`getResolved()`) for connectors to actually call with. Also owns secret redaction
  (see [Admin UI and Admin API](#admin-ui-and-admin-api)). `setFilePath(gatewaysFile)` is the
  gateways half of "Change folder".

Neither registry needs an explicit "reload" call after an admin API mutation — `upsert()`/`remove()`
update the in-memory state directly. `POST /admin/api/reload` exists specifically for the case where
someone hand-edited a file on disk (bypassing the admin API entirely) and wants the running server to
pick it up without a restart. Both registries' backing path is mutable at runtime (`endpointsDir`/
`filePath` are plain instance fields, not `readonly`) specifically so `setDir()`/`setFilePath()` can
repoint the *same* registry instances — used by every other module that already holds a reference to
them (`dispatch.ts`, `adminApi.ts`) — at a different folder without reconstructing anything.

### Folder layout mirrors each endpoint's path

`config/endpoints/` is organized into nested folders that mirror each endpoint's own URL path, computed by
`src/server/endpointFileLayout.ts`'s `endpointPathToFolderSegments()` + `computeEndpointFile()`. For example, an
endpoint at `/api/customers/:id` is stored at
`config/endpoints/api/customers/[id]/<endpoint-id>.yaml`. A `:id`-style path-param segment becomes a
`[id]` folder (square brackets are filesystem-safe on every OS; a literal `:` is not, on Windows).
Multiple endpoints that share a path but differ by method — most notably a generated table's
GET/POST/PATCH/DELETE, all at `/api/<gateway>/<table>` — land in the *same* folder as sibling
files, using each endpoint's own id as the leaf filename, which avoids collisions and groups exactly the
endpoints that are most useful to browse together.

This is **purely a storage convenience with zero runtime-behavior risk**: `EndpointRegistry.match()` only
ever reads the `path` field parsed out of an endpoint's YAML *content*; it never looks at where the file
happens to live on disk. `loader.ts`'s file discovery (`listConfigFiles()`) is a full recursive
directory walk, so an endpoint file works identically whether it's nested ten folders deep or sitting flat
at the top of `config/endpoints/` — hand-adding a file anywhere in the tree is fine.

`EndpointRegistry.upsert()` recomputes the correct file location every time (from the endpoint's *current*
id and path) and moves the file if either one changed since the entry it's replacing — a rename alone,
a path edit alone, or both. After removing a stale file (on a move, or on `remove()`), it walks upward
from that file's directory pruning any folder that's now empty, stopping at the first non-empty
directory or at `ENDPOINTS_DIR` itself (which is never removed). See `cleanupEmptyDirs()` in
`endpointRegistry.ts`.

The admin UI's Endpoints tab renders the same grouping as a collapsible folder tree (`admin.js`
`buildEndpointTree()`/`renderEndpointsTree()`), but deliberately displays the *raw* path segment (`:id`) for
readability rather than the filesystem's bracket form (`[id]`) — a considered display/storage split:
the bracket convention is a filesystem-safety concern with no reason to leak into what a human reads,
where the literal syntax they'd type into the endpoint form's Path field is more legible.

### Workspace

This project runs as **one process per person, on that person's own machine** — there is no login
system, no multi-tenant request routing, and no server shared between users. Where a team actually
shares endpoints/gateways is a **Git repo**: each person keeps their own local checkout of it and
points their own instance at that checkout's folder — their **workspace**. The app itself never shells
out to `git` — commit/push/pull are the user's own job, entirely outside this process. This shaped the
feature as "which single workspace is this instance currently reading from" (a per-machine setting,
mutated in place), not as any kind of per-request multi-tenancy.

A **workspace** is any folder containing (or that will come to contain) an `endpoints/` subfolder and a
`gateways.yaml` file — the same layout `config/` itself uses. `resolveConfigDir()`
(`src/server/workspaceSettings.ts`) is the one place that convention is encoded:
`{endpointsDir: join(configDir, "endpoints"), gatewaysFile: join(configDir, "gateways.yaml")}` — note
that the field/variable name is still `configDir` throughout the code, settings file, and HTTP API; only
the human-facing name (UI labels, docs, comments) changed to "workspace", so that's a stable data
contract this doc keeps calling by its real name wherever code is involved.

**Resolution order at startup** (`resolveStartupPaths()` in `src/server/index.ts`), highest priority
first:

1. A workspace previously saved through the admin UI, read back via `loadWorkspaceSettings(SETTINGS_FILE)`
   — `SETTINGS_FILE` defaults to `data/settings.json`, resolved relative to `process.cwd()`. This file
   deliberately lives *outside* any workspace (since the whole point is that the workspace can
   be swapped for an entirely different Git checkout) and is not meant to be committed to Git — it is a
   per-machine preference, not shared project config (see `.gitignore`). The persisted `configDir` is
   resolved with `path.resolve(process.cwd(), persisted.configDir)` before use — a no-op for the absolute
   path the admin UI always saves (see step 2 below), but it also makes a **relative** value in a
   hand-edited `settings.json` resolve correctly (e.g. `"configDir": "config"` to point at this project's
   own bundled `config/` folder — see the note on packing a real workspace in as the project's own
   default, below), rather than that only working by accident of what `path.join` happens to produce.
2. `CONFIG_DIR` env var, if set — same one-folder-holds-both convention, useful for a first run or
   scripted/CI setup before anyone's touched the admin UI.
3. Legacy `ENDPOINTS_DIR`/`GATEWAYS_FILE` env vars, resolved independently (each defaulting to this
   project's own `config/endpoints`/`config/gateways.yaml`) — the pre-workspace-feature behavior,
   unchanged, for anyone who wants endpoints and gateways stored in unrelated locations rather than one
   shared workspace.

**Switching workspaces at runtime** — `PUT /admin/api/settings` (`{configDir}`) in `adminApi.ts`:

1. Resolves and validates `configDir`: it must already exist as a directory on disk (this app will
   never silently create an arbitrary folder somewhere on someone's machine from a typo) — a missing
   folder is a `400 ValidationError` naming the path and suggesting the Git checkout step. Nothing
   further inside it needs to exist yet: `EndpointRegistry`/`GatewaysRegistry` already tolerate a
   missing `endpoints/`/`gateways.yaml` (loading as empty) and create them on first save, same as they
   always have for `config/` itself — this is what makes pointing at a brand-new, still-empty team repo
   work with no extra step.
2. Calls `closeAllSqlConnections()` **before** switching — any pooled SQL client (an open sqlite file
   handle, a live pg/mysql/mssql pool) opened for the *old* workspace's gateways is no longer relevant
   once a different `gateways.yaml` is in effect, and is closed rather than left to leak until
   process exit.
3. Calls `endpointRegistry.setDir(endpointsDir)` and `gatewaysRegistry.setFilePath(gatewaysFile)` — the
   *same* registry instances `dispatch.ts` and the rest of `adminApi.ts` already hold references to, so
   every other endpoint (live data endpoints, `/admin/api/endpoints`, `/admin/api/gateways`, …) reflects the
   new workspace starting with the very next request, no restart, exactly like any other admin API change.
4. Updates the in-memory `workspace.configDir` (a small mutable `{configDir?: string}` object threaded
   through `index.ts` → `app.ts` → `adminApi.ts` by reference, since `EndpointRegistry`/`GatewaysRegistry`
   don't necessarily share one common parent folder in legacy mode, so "the current workspace" has
   to be tracked as its own piece of state rather than derived from either registry) and persists it via
   `saveWorkspaceSettings(settingsFile, {configDir})`, so the choice survives the next `npm start`.

`GET /admin/api/settings` reports `{configDir, endpointsDir, gatewaysFile, endpointCount, gatewayCount}`
— `configDir` is `null` when running in legacy mode (no workspace ever chosen via `CONFIG_DIR` or the UI).

**Admin UI**: a bar under the header (`#workspace-path`/`#workspace-counts` in `index.html`, rendered by
`renderWorkspaceBar()` in `admin.js`, refreshed as part of the same `loadAll()` every other change
already triggers) shows the current workspace and endpoint/gateway counts; "Change workspace…" opens a
small drawer (`#workspace-editor`) with a single text field, following the same
`saveX()`-then-`closeDrawer()`-then-`await loadAll()` order every other editor in this file already uses.

**Packing a real workspace in as the project's own default**: rather than pointing at a folder that
lives *outside* the checkout (which is what the admin UI's "Change workspace" always produces — an
absolute path, since it's meant to reach anywhere on disk), a checkout can instead be made fully
self-contained by moving a real `endpoints/`/`gateways.yaml` folder to replace the project's own
`config/` folder directly, and setting `data/settings.json` to `{"configDir": "config"}` (or deleting
the file/leaving `configDir` unset entirely, which falls through to the same
`config/endpoints`/`config/gateways.yaml` default via step 3 above — pointing `configDir` at `"config"`
explicitly is only needed if the admin UI's workspace bar should keep showing an active workspace rather
than reporting legacy/`null` mode). This avoids the fragility of an absolute path baked into a
per-machine preference file: renaming or relocating the whole checkout (as happened during this
project's own setup — see the Changelog) no longer risks a stale `configDir` pointing at a folder that
no longer exists, since the path travels with the checkout.

Because there's no shared server between users, it's normal (and not a bug) for two teammates' running
instances to show different endpoints/gateways at the same time if they're on different Git branches or
haven't pulled the same commit — reconciling that is an ordinary Git merge on the files in their
workspace, the same as any other files in the repo.

**Security note**: the `config/` folder shipped with this project is a demo default — every gateway in it
resolves its connection details from `${env.*}` placeholders, not literal values, so it's safe to commit.
If you replace it with a real `gateways.yaml` the way this section describes, and that file has a literal
credential in it (a SQL gateway's password, say, rather than an env-var reference), stop and treat `config/`
the same way `data/settings.json` is already treated in `.gitignore`: as a per-machine file that must never
be committed. The cleanest fix is usually to move the credential itself into an env var (every connector
already supports `${env.VAR_NAME}` in gateway fields — see [Gateway config reference](#gateway-config-reference))
so `config/` stays safe to commit even after the swap; add a local-only `.gitignore` entry for `/config/`
instead only if the real file must keep a literal secret in it.

## Backend connectors

Every connector lives in `src/connectors/` and implements one function —
`call<Type>Backend(backend, ctx): Promise<BackendResult>` — with an identical contract: take a parsed
backend config plus a `ConnectorContext` (resolved gateways, resolved params, a scoped logger, and
the raw request query/body for the two SQL modes that need them — see `connectors/types.ts`), return a
plain JS value (object or array) ready for the output mapper. None of them know anything about endpoints,
HTTP status codes for the *middleware's own* response, or output mapping — that separation is what lets
`adminApi.ts`'s test endpoints call a connector directly (for "fetch a sample" during endpoint creation)
without a saved endpoint existing at all.

`connectors/index.ts`'s `callBackend()` is the only entry point anything outside `connectors/` calls;
it dispatches on `backend.type` and, before doing so, layers the referenced gateway's
`commonParams` under `ctx.params` (see [Gateway config reference](#gateway-config-reference)).

### JSON connector

`src/connectors/json.ts`. Resolves the backend's `url` against the gateway's `baseUrl` (only when
`url` doesn't already look absolute, i.e. doesn't start with `http(s)://`), resolves `{param}`
placeholders in the URL/headers/query/body via `paramSubst.ts`, and makes the request with `axios`
(`validateStatus: () => true`, so a 4xx/5xx response is inspected rather than throwing inside axios
itself — the connector raises its own `Error` with `statusCode`/`backendBody` attached, which
`dispatch.ts`'s `wrapError()` passes through as-is to the centralized error handler). Returns
`response.data` directly — whatever shape the JSON backend returned.

### XML connector

`src/connectors/xml.ts`. Same URL-resolution and `{param}`-substitution approach as JSON, but the
`body` field (when present) is a raw XML *string template*, not a JSON object — placeholders are
resolved directly against that string. The request is made with `responseType: "text"`, and the
response body is parsed with `fast-xml-parser`'s `XMLParser` (configured with
`ignoreAttributes: false`, `attributeNamePrefix: "@_"`, `trimValues: true`, `parseTagValue: false`,
`parseAttributeValue: false`) into a plain JS object before being handed to the mapper. Repeated
sibling XML tags become a JS array automatically (this is what `output.root` is for — see the
`xml-customers-list` example endpoint). One caveat worth knowing: a single occurrence of a repeatable
tag parses as a plain object, not a one-element array — a mapping that assumes an array for a
collection endpoint should be tested against both a multi-item and a single-item response if that's a
real possibility for that backend.

**`parseTagValue`/`parseAttributeValue: false`**: fast-xml-parser's default is to guess at numbers and
booleans from tag/attribute text (`"007"` → `7`, `"true"` → `true`). That guess is silent and
irreversible — it can't tell a real number from an id, code, or SKU that merely looks like one — so
it's disabled here; every text value comes back exactly as written in the XML, as a string, the same
way the JSON/SQL connectors already return whatever type the backend actually sent. A field that
genuinely needs a number or boolean opts in explicitly via `transform: toNumber`/`toBoolean` on that
one output field (`transform/mapper.ts`) rather than the parser silently deciding for every field at
once. (Before this, `id: "1"`/`"2"`/`"3"` in the demo XML backend's data — see
`src/mock-backend/data.ts` — round-tripped through XML and came back as the *numbers* `1`/`2`/`3`,
inconsistent with the same ids over JSON/SQL; that's now fixed as a side effect of the same change —
see the 2026-09-03 changelog entry below.)

**Raw response preservation**: the object the parser produces is a real reshaping of the original XML
(see "Output mapping" below for exactly what that reshaping can lose or distort — array-vs-object
cardinality depending on item count, mixed content, unresolved namespace prefixes), so the connector
logs the untouched response text at debug level (`ctx.logger.debug({..., rawResponse}, "XML backend raw
response")`) before parsing it. Nothing currently reads this back programmatically — it's there so
`LOG_LEVEL=debug` shows the exact bytes that produced a given (possibly surprising) mapped value,
without needing to reproduce the backend call by hand.

### SOAP connector

`src/connectors/soap.ts`. Uses the `soap` npm package's client. WSDL fetch+parse is comparatively
expensive, so clients are cached per resolved WSDL URL in a module-level `Map<string, Promise<Client>>`
(`clientCache`) — caching the *Promise*, not just the resolved client, so concurrent first-requests for
the same WSDL share one in-flight fetch instead of racing to build several clients. There's currently
no eviction from this cache (a WSDL URL that changes at runtime, e.g. via `${env.X}` pointing somewhere
new after a gateway edit, gets a fresh cache entry under its new URL string — the old client object
is simply never used again, not explicitly destroyed, which is fine since a SOAP client holds no
persistent connection/pool the way a SQL client does).

The backend's `operation` field must match a method the `soap` package generates on its client as
`<operation>Async` (this is how the `soap` package's WSDL-driven client works — every SOAP operation in
the WSDL gets both a callback-style and an `Async` promise-style method; this connector always calls
the `Async` one). The **endpoint actually called** defaults to the WSDL URL with its query string
stripped (the common `?wsdl` suffix convention) — this is a workaround for WSDLs that declare a stale
or internal `<soap:address>` that the client shouldn't literally connect to; `backend.endpoint` can
override this when a WSDL's declared address genuinely is correct, or points somewhere different from
where the WSDL itself was fetched.

Unlike the XML connector, the `soap` package doesn't auto-guess numbers/booleans from response text —
`customerId` comes back as the string `"3"`, not the number `3` (see the "XML backend"/"SOAP backend"
describe blocks in `test/middleware.test.ts`, which pin exactly this asymmetry) — so no equivalent
`parseTagValue`-style fix was needed here. **Raw response preservation** still applies the same way as
XML: after the call, `client.lastResponse` (the `soap` package's own capture of the last raw response
body) is logged at debug level alongside `result` (the already-unwrapped body it parsed), so
`LOG_LEVEL=debug` shows the actual SOAP envelope XML a mapping was evaluated against.

### SQL connector

`src/connectors/sql.ts`. The most complex connector, with three distinct calling modes sharing one
knex-instance-and-pool cache.

**Connection pooling.** Every named SQL *gateway* gets one long-lived `knex()` instance (and
therefore one connection pool — knex uses `tarn.js` internally), cached in a module-level
`knexCache: Map<string, Knex>` keyed by **`<gateway name>::<JSON of its resolved config>`** — not
just the name. That content-based key means editing a gateway's host/credentials/pool settings
through the admin UI naturally computes a different key on the next call: `getKnex()` detects any
other cache entry for the same gateway *name* with a *different* key, destroys it in the background
(`.destroy().catch(() => undefined)`, best-effort, not awaited), and lazily builds a fresh instance
under the new key. There is no pooling code of this project's own beyond that cache map — sizing,
acquisition, and idle-connection management are entirely knex's/tarn's. Pool defaults (when a
gateway's `pool` field is omitted): `{ min: 2, max: 10 }` for pg/mysql2/mssql, and `{ min: 1, max: 1 }`
for sqlite3/better-sqlite3 (knex intentionally serializes access to a single-writer file database). A
gateway's optional `pool` object (e.g. `{ min: 5, max: 20, idleTimeoutMillis: 30000 }`) is passed
straight through to knex — the schema accepts it (`z.record(z.unknown())`) but as of this writing the
admin UI's gateway editor form doesn't expose it as a dedicated field; it can be set today by
editing `gateways.yaml` directly or via a raw `PUT /admin/api/gateways/:name` body.

Two call sites deliberately bypass this shared cache and open their own **standalone, throwaway**
`knex()` instance instead, always torn down in a `finally` block right after use: `testSqlConnection()`
(the admin UI's "Test connection" button) and `introspectSqlGateway()` (CRUD generation). Both may
run against a gateway config that's mid-edit and never gets saved, so they can't safely touch the
long-lived cache, and both are one-shot operations where opening a fresh connection is cheap relative
to the correctness risk of reusing/polluting the real pool.

**Raw-query mode** (`backend.query` set): `db.raw(query, ctx.params)`. Knex's `.raw()` supports named
`:paramName` bindings when given an object of params, so endpoint authors write plain parameterized SQL.
`normalizeSqlResult()` flattens the driver-specific result shape to a plain row array (`mysql2` returns
`[rows, fields]`; `pg` returns `{rows, ...}`; other drivers already return a plain array).

**Generated table-CRUD mode** (`backend.table` + `backend.operation` set) — this is what
`crudGenerator.ts` generates (see [Auto-generated CRUD + stored-procedure endpoints](#auto-generated-crud--stored-procedure-endpoints)),
but can also be written by hand. Unlike every other backend mode, these four operations read from
`ctx.rawQuery`/`ctx.rawBody` — the caller's *actual* Express `req.query`/`req.body`, plumbed through
by `dispatch.ts` and (for admin-UI test calls) `adminApi.ts` — rather than the declarative named
`input`/`extractParams` pipeline every other endpoint uses. That pipeline only extracts named scalar
values; bulk operations need a whole array of rows/updates/keys, which the scalar pipeline has no way
to express.

  - `list` — `db(table)`, filtered by `.andWhere(col, value)` for every query-string key that's both
    *not* one of the reserved keys (`limit`, `offset`, `sort`, `order`, `ids`) and present in
    `backend.columns` (a whitelist generated once at introspection time, so there's no per-request DB
    round-trip needed to know which filter keys are safe — and no way to filter on a column that isn't
    real). `ids=1,2,3` is supported only for single-column-primary-key tables, translating to
    `.whereIn(pk, [...])`. `sort`/`order` apply an `.orderBy()`, also whitelisted against `columns`.
    `limit` defaults to 100, capped at 1000; `offset` defaults to 0. All filtering is **exact match
    only** — there's no operator syntax (`>`, `LIKE`, etc.) in this generated mode.
  - `bulkCreate` — body must be `{ "rows": [ {...}, ... ] }`, validated non-empty and each entry a
    plain object (`ValidationError` otherwise). `.returning('*')` is requested only for `pg`/`mssql`
    (the only knex dialects that actually return inserted rows from it — mysql2/sqlite silently ignore
    it or return only a partial insert id for a multi-row insert), so the response's `rows` field is
    `null` on every other dialect and only `insertedCount` is meaningful there.
  - `bulkUpdate` — body must be `{ "updates": [ { "key": {...}, "fields": {...} }, ... ] }`. Every
    `key` must contain **exactly** the table's declared `primaryKey` columns — `validateKey()` rejects
    both a missing and an *extra* column, naming which, as a safety net matching the deliberate
    "primary-key-list only" design (an open-ended WHERE-style filter was explicitly rejected during
    design so a typo in a filter can never touch more rows than intended). All entries in one request
    run inside a single `db.transaction()` — all-or-nothing.
  - `bulkDelete` — body must be `{ "keys": [ {...}, ... ] }`, same `validateKey()` rule, same
    single-transaction semantics as `bulkUpdate`.

**Generated stored-procedure mode** (`backend.procedure` set) — unlike table-CRUD, procedure
parameters flow through the *normal* `input`/`ctx.params` pipeline (each generated as `in: "body"`),
since they're just scalar values; this is also why a generated procedure endpoint (unlike a generated
table endpoint) works fine in the admin UI's "Try it" test panel. Builds `CALL name(:p1, :p2)` for
pg/mysql2 or `EXEC name :p1, :p2` for mssql (reusing the same named-binding support raw-query mode
relies on), and throws for sqlite3/better-sqlite3, which have no stored-procedure concept at all.

**SQL introspection** (`src/connectors/sqlIntrospect.ts`, `introspectSqlGateway()`) — opens its own
standalone knex instance and discovers, per dialect:

- **sqlite3 / better-sqlite3**: `sqlite_master` for table names, `PRAGMA table_info(??)` (knex `??`
  identifier binding) for columns and primary key (composite keys sorted by the PRAGMA's own `pk`
  ordinal). Returns `proceduresSupported: false` — SQLite has no stored-procedure concept.
- **pg / mysql2 / mssql**: real `information_schema.tables` / `.columns` /
  `.key_column_usage`+`.table_constraints` (joined, for primary keys) queries (mssql uses
  `INFORMATION_SCHEMA.*`, uppercase, since that's the catalog's own convention), plus
  `information_schema.routines` + `.parameters` (filtered to `ROUTINE_TYPE = 'PROCEDURE'`, excluding
  functions) for stored procedures and their ordered parameter names. mssql parameter names come back
  with a leading `@` (e.g. `@customerId`), stripped for the generated endpoint's own input param names.

  **Every selected column in these three dialects' queries is explicitly aliased**
  (`.select({ column_name: "column_name" })`, or for a joined/qualified column,
  `.select({ column_name: "kcu.column_name" })`) rather than selected as a bare column name. This is
  the fix for a real bug (see the [Changelog](#changelog) entry "MySQL `information_schema`
  column-casing bug"): an *unaliased* system-catalog column's returned JS-object-key casing is not
  guaranteed to match how the query was written — it's a documented cross-database, and even
  cross-version, inconsistency — whereas an explicit `AS` alias is guaranteed by the SQL standard to
  control the result set's field name outright. All property names were also normalized to a
  consistent lowercase (`column_name`, `data_type`, `is_nullable`, `routine_name`, `specific_name`,
  `parameter_name`) for uniformity across dialects, including in `introspectMssql`, which previously
  used the catalog's own literal uppercase key names.

## Auto-generated CRUD + stored-procedure endpoints

`src/server/crudGenerator.ts`'s `generateCrudEndpointsForGateway()`, triggered by
`POST /admin/api/gateways/:name/generate-crud` (and the admin UI's "Generate CRUD + procedure
endpoints" button, shown only when editing an already-saved SQL gateway — generation introspects the
version on disk, so a brand-new draft has nothing to introspect yet).

**Design decisions** (all chosen as the "recommended" option when this feature was originally
clarified): generation is **on-demand**, never automatic on gateway save; bulk update/delete target
rows by an **exact primary-key list** in the request body, never an open-ended filter (so a typo can
never touch more rows than intended — this is the origin of `validateKey()`'s strict
missing/extra-column check in the SQL connector); and re-running generation **skips and reports** any
conflict rather than overwriting, making it always safe to re-run (e.g. after adding a table).

**What gets generated**, per table, at `/api/<gateway>/<table>`:

| Method | Endpoint id suffix | Backend `operation` | Requires a primary key? |
|---|---|---|---|
| GET | `-list` | `list` | No |
| POST | `-create` | `bulkCreate` | No |
| PATCH | `-update` | `bulkUpdate` | Yes |
| DELETE | `-delete` | `bulkDelete` | Yes |

A table with **no primary key** only gets the `-list` and `-create` endpoints — update/delete need a
reliable way to target a specific row, which a table with no primary key can't offer. This is recorded
as an explicit `skipped` entry (`reason: "table has no primary key -- ..."`), not silently omitted, so
the generation summary always accounts for every table it saw.

One endpoint per stored procedure (only when the dialect supports them) at
`POST /api/<gateway>/proc/<name>`, with id `<gateway>-proc-<name>`, and `input` generated as
`{ name, in: "body", required: false, type: "string" }` for each of the procedure's own declared
parameter names.

**Safety on names**: a table or procedure name not matching `/^[A-Za-z0-9_]+$/` is skipped entirely
(`reason: "... characters unsafe for a URL path -- skipped"`) rather than risking a broken
`path-to-regexp` pattern or a surprising, hard-to-predict endpoint id.

**Skip-and-report conflict handling** (`tryUpsert()`): before calling `endpointRegistry.upsert()`, checks
whether the intended endpoint id is already in use, or whether the intended method+path is already
claimed by a *different* endpoint id (a hand-written endpoint, or one from an earlier generation run) — either
case is recorded as a skip with a human-readable reason instead of throwing, so one conflicting table
or procedure never aborts generation for the rest. `endpointRegistry.upsert()` failing for any other
reason (a schema violation that somehow slipped through) is also caught and reported as a skip rather
than propagating, for the same reason.

The generate-crud endpoint's response shape:

```json
{
  "gateway": "demoDb",
  "tablesFound": 3,
  "proceduresFound": 0,
  "proceduresSupported": true,
  "created": [ { "id": "demoDb-customers-list", "method": "GET", "path": "/api/demoDb/customers" }, ... ],
  "skipped": [ { "kind": "table", "name": "tags", "reason": "table has no primary key -- only list/create endpoints were generated (update/delete need one to target specific rows)" } ]
}
```

**Admin UI interaction with generated endpoints**: an endpoint whose backend has `table` or `procedure` set
(i.e. was created by this feature, or hand-written to look like it) renders as a **read-only summary**
in the endpoint editor's Backend section rather than the normal editable fields for its type — see the
branch in `admin.js`'s `renderBackendFields()` checking `backend.table || backend.procedure`. This
exists specifically to prevent a real bug: the SQL backend field renderer used to unconditionally
render a raw-query textarea whose `_read()` always produced `{type:"sql", query: ...}` — opening a
generated endpoint and clicking Save with zero edits would have silently replaced its
table/operation/procedure config with an empty raw query. The read-only branch's `_read()` instead
returns the original `backend` object untouched. A generated *table* endpoint also can't be exercised from
the endpoint editor's "Try it" panel (that panel only has fields for scalar named params, and table-CRUD
operations read a whole `rows`/`updates`/`keys` array from the raw body/query) — `#tryit-bulk-note`
in `index.html`, toggled in `openEndpointEditor()`, tells the user to use curl/Postman instead. A generated
*procedure* endpoint is unaffected by any of this, since its params flow through the ordinary declarative
`input` pipeline.

## Output mapping engine

`src/transform/mapper.ts`. Takes an endpoint's `output` config and the raw value a connector returned, and
produces the JSON the caller actually gets. Two modes:

- **`output.root` set** — a JSONPath expression (via the `jsonpath-plus` package, `wrap: true`)
  selects an array of items from the raw response; `mapItem()` runs independently for each item, and
  the endpoint returns a JSON array.
- **`output.root` omitted** — the whole raw response is passed to `mapItem()` once, and the endpoint
  returns a single JSON object.

For each `field` in `output.fields`, in order: `extractSource()` evaluates `field.source` (a JSONPath
expression) against the item (or whole response); if there's no match, `field.default` is used
instead; if a value was found either way, `field.transform` (`toString | toNumber | toBoolean | trim |
upper | lower` — each a small, permissive coercion that falls back to the original value on failure
rather than throwing, e.g. `toNumber` on a non-numeric string just returns the string unchanged) is
applied to it; the result, if not `undefined`, is written into the output object at `field.target` via
`setDeep()`. `setDeep()` splits a target like `"tags[0].label"` into path segments (`["tags","0",
"label"]`), auto-vivifying an array at a segment when the *next* segment is a bare numeral, or an
object otherwise, as it walks/creates the path. A field that resolves to `undefined` (no source match
*and* no default) is simply never written — the output object never gets an explicit `null` for a
field that had nothing to map, keeping generated JSON free of placeholder nulls unless a `default` was
explicitly given.

**JSONPath only, and what that costs against an XML/SOAP-sourced response**: `output.source` is always
evaluated as JSONPath (`jsonpath-plus`), for every backend type — there's no XPath option, deliberately
(see the design discussion in the 2026-09-03 changelog entry below for the fuller reasoning). For a JSON
or SQL backend this is a non-issue: the raw value already is the structure being queried. For XML/SOAP,
it means JSONPath is run against the *parsed* object (see the XML/SOAP connector notes above), which is
a real reshaping of the original document, not just a format conversion — a few things that reshaping
can lose or distort, worth knowing when a mapping doesn't behave as expected:

- **Cardinality ambiguity** — a tag that occurs once parses as a plain object; the same tag occurring
  twice or more parses as an array. A `source`/`root` written and tested against a single-item sample
  can silently stop matching (or start matching differently) once a response happens to contain a
  different number of items. `output.root` exists partly to make this explicit for collection
  endpoints, but a nested repeatable element deeper in the tree has the same risk.
- **Mixed content** (text interleaved with child elements) loses its exact position — `fast-xml-parser`
  puts element and text content into separate keys, so `<p>Hello <b>world</b>, bye</p>` produces
  `{b: "world", "#text": "Hello, bye"}`, not something that preserves "world" as being between "Hello"
  and ", bye".
- **Namespace prefixes are kept as literal string parts of the key**, not resolved — `<ns:Foo
  xmlns:ns="...">` becomes the JSON key `"ns:Foo"` verbatim. Two different prefixes bound to the same
  namespace URI look like two unrelated keys.
- **No sibling/ancestor navigation** — JSONPath only descends top-down through the parsed object; there's
  no equivalent of XPath's `following-sibling::`/`ancestor::` axes, because once flattened into nested
  JS objects/arrays there's no parent pointer to walk back up or sideways from.

None of these are new as of this note — they're inherent to evaluating JSONPath against a
`fast-xml-parser` object rather than a real XML DOM. What *did* change (2026-09-03): text values used to
also be silently auto-coerced into numbers/booleans (`"007"` → `7`); that specific distortion is now
fixed (`parseTagValue: false` in the XML connector — see above), so what's left is genuinely structural,
not a value going quietly wrong. If one of these turns out to matter for a real endpoint, the raw
response is still available via `LOG_LEVEL=debug` (see the connector notes above) to see exactly what
the parser was handed.

## Admin UI and Admin API

**Auth** (`src/server/adminAuth.ts`): every `/admin/api/*` request must carry
`Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` isn't set in the environment at all, the admin
API is disabled outright (`503 AdminDisabled`) rather than ever running unauthenticated — deliberate,
since the admin API can configure an endpoint that calls an arbitrary URL or runs arbitrary SQL. The token
comparison uses `crypto.timingSafeEqual` (after confirming equal length, since that function throws on
a length mismatch rather than returning `false`) to avoid a timing side-channel on the comparison
itself. The admin UI's static files (`/admin/*`, `index.html`/`admin.js`/`admin.css`) are served
*without* this gate — there are no secrets in the frontend bundle; every actual API call the page makes
carries whatever token the user typed into the login screen, stored in `localStorage` under
`naimix-admin-token`.

**Full endpoint reference:**

| Method & path | Purpose |
|---|---|
| `GET /admin/api/meta` | Schema enum values (methods, backend types, transforms, SQL clients, param locations/types) — keeps the frontend's dropdowns from hardcoding (and drifting from) what `schema.ts` actually allows. |
| `GET /admin/api/endpoints` | List every endpoint (full parsed config, not redacted — endpoints don't hold secrets directly). |
| `GET /admin/api/endpoints/:id` | One endpoint's full config. |
| `POST /admin/api/endpoints` | Create an endpoint. Body is a full endpoint config; validated, persisted to its nested file location, live immediately. |
| `PUT /admin/api/endpoints/:id` | Update (or rename) an endpoint. Same body shape as POST; the old file is deleted/moved as needed. |
| `DELETE /admin/api/endpoints/:id` | Delete an endpoint and its backing file (pruning now-empty folders). |
| `POST /admin/api/endpoints/:id/test` | Run an already-saved endpoint live with caller-supplied param overrides (`{ params, rawQuery?, rawBody? }`); returns `{ raw, mapped }`. |
| `POST /admin/api/test-backend` | Call a backend that isn't saved as an endpoint yet — `{ input, backend, params, rawQuery?, rawBody? }` → `{ raw }`. Used while building an endpoint, before Save. |
| `POST /admin/api/test-mapping` | Re-apply an `output` config to an already-fetched sample (`{ raw, output }` → `{ mapped }`) without re-calling the backend — avoids re-running a non-idempotent write on every mapping-field keystroke. |
| `POST /admin/api/reload` | Re-reads `config/endpoints/` and `gateways.yaml` from disk, for picking up hand-edited files. |
| `GET /admin/api/settings` | `{ configDir, endpointsDir, gatewaysFile, endpointCount, gatewayCount }` — the workspace this instance is currently reading from (`configDir` is `null` in legacy mode). See [Workspace](#workspace). |
| `PUT /admin/api/settings` | `{ configDir }` → repoints both registries at that folder, closes any SQL pools opened for the old one, persists the choice, and switches live immediately. `400` if the folder doesn't exist on disk. |
| `GET /admin/api/gateways` | List every gateway, secrets redacted. |
| `GET /admin/api/gateways/:name` | One gateway, secrets redacted. |
| `POST /admin/api/gateways` | Create a gateway — `{ name, config }`, `409` if the name's already taken. |
| `PUT /admin/api/gateways/:name` | Update a gateway — `{ config }`. A blank sensitive field means "keep the stored value". |
| `POST /admin/api/gateways/test-connection` | Test real reachability (SQL only) — `{ name?, config }` → `{ ok: true }` or `{ ok: false, message }`. `name`, if given, lets a blank sensitive field in the draft fall back to that gateway's real stored secret. |
| `POST /admin/api/gateways/:name/generate-crud` | Introspect + generate table-CRUD/procedure endpoints for a saved SQL gateway — see the dedicated section above. |
| `DELETE /admin/api/gateways/:name` | Delete a gateway — `409` (with the list of dependent endpoint ids) if any endpoint still references it. |

A zod validation failure anywhere in this router is caught by a dedicated error-handling middleware at
the bottom of `createAdminApiRouter()` and turned into `400 { error: "ValidationError", message,
issues }`, where `issues` is zod's own `issues` array (each with a `path` naming the offending field) —
this is what lets `admin.js`'s `api()` helper attribute an error to a specific form field rather than
showing an opaque top-level message. `gatewayConfigSchema` is a plain `z.union` (not
`z.discriminatedUnion`, since `kind` is optional on 3 of its 4 branches) — a union failure normally
collapses to one opaque top-level `invalid_union` issue with an empty `path`, which is why
`gatewaysRegistry.ts`'s `parseGatewayConfig()` exists: on a union failure it picks out the
`unionErrors` branch that doesn't itself fail on `kind` (i.e. the branch matching what was actually
submitted) and re-throws a `ValidationError` built from *that* branch's real field-level issues.

**Secret handling** (`gatewaysRegistry.ts`): any object key matching
`/pass|secret|token|apikey|api_key|credential/i` is treated as sensitive. `listRedacted()`/the
`GET`/`redact()` path replaces such a value with a fixed placeholder (`"••••••••"`) before it ever
reaches the browser — except a literal `${env.X}` reference, which is safe to show as-is since it names
an environment variable, not the secret itself. On save (`upsert()`/`mergeUnchangedSecrets()`), an
**empty string** submitted for a sensitive field means "leave the previously stored value unchanged",
not "set it to empty" — so the UI never needs to round-trip a real secret back into the browser just to
leave a form otherwise unchanged. This recursive merge walks the whole config tree by key, so it
applies uniformly to `commonParams` or any nested SQL `connection` field named like a secret, not just
a few hardcoded top-level fields.

**Frontend architecture** (`public/admin/`, plain HTML/CSS/JS, no build step, served via
`express.static`):

- `admin.js`'s `api()` is the single fetch wrapper every call goes through: attaches the bearer token,
  logs the user out on a `401`, and turns a JSON error body into a thrown `Error` with a field-attributed
  message when `issues` is present.
- **Split-pane layout** — a fixed-width sidebar (`.sidebar`) on the left holds two always-visible list
  sections, Endpoints and Gateways; a flexible detail panel (`#detail-panel`) on the right shows either
  a placeholder (`#detail-empty`) or the selected item's inline editor. There is no separate "view" to
  switch between — selecting any endpoint or gateway from either list drives what the right panel shows,
  via `showDetailView("endpoint" | "gateway" | null)` and the module-level `ACTIVE_DETAIL` /
  `EDITING_ENDPOINT_ID` / `EDITING_GATEWAY_NAME` state. Below ~900px the layout stacks vertically
  (sidebar on top, capped at 40vh) instead of side-by-side.
- **Endpoints list** — a collapsible folder tree (`buildEndpointTree()`/`renderEndpointsTree()`/
  `renderEndpointTreeNode()`) grouped by path segment, matching the on-disk layout (see
  [Folder layout mirrors each endpoint's path](#folder-layout-mirrors-each-endpoints-path)); collapse state
  (`COLLAPSED_ENDPOINT_FOLDERS`, a `Set` of folder paths) is in-memory only, resetting on reload. Each row
  opens that endpoint into the detail panel on click (`openEndpointEditor(r.id)`) and is highlighted
  (`.endpoint-row.selected`) while it's the one showing there.
- **Gateways list** — `renderGatewaysList()` renders the same row language as the endpoint tree (kind
  badge, name, one-line summary) instead of a table, so both lists in the sidebar read consistently;
  clicking a row opens that gateway into the detail panel (`openGatewayEditor(name)`).
- **Workspace bar** — a slim bar under the header (`renderWorkspaceBar()`, refreshed as part of the
  same `loadAll()` every other change already triggers) showing the current workspace and counts;
  "Change workspace…" opens a one-field drawer (`#workspace-editor`/`saveWorkspace()`) that calls
  `PUT /admin/api/settings`. See [Workspace](#workspace). This settings dialog is the one place that
  still uses the slide-in `.drawer` pattern — the endpoint and gateway editors are inline panel content,
  not drawers/modals.
- **Backend Type is inferred from Gateway, not asked for separately** — `applyGatewayInferredType()`
  sets `backendType.value` to the selected gateway's `kind` and disables the Type select (with a
  "(set by the selected gateway)" hint) whenever a gateway is chosen, re-rendering the backend fields
  only if the kind actually changed (switching between two gateways of the same kind keeps whatever the
  user already typed). Type is a gateway's inference exactly because the two are never allowed to
  disagree in the first place: `src/connectors/index.ts`'s `callBackend()` switches purely on
  `backend.type` to pick a connector, and that connector then looks up the named gateway expecting its
  shape (e.g. `callSqlBackend` expects `client`/`connection`) — a `type: "json"` backend pointed at a
  `kind: "sql"` gateway would call the wrong connector and just fail, so there was never a real "choice"
  to expose there once a gateway is picked. Type is left manually editable only when Gateway is
  "(none)" — the direct-URL case for json/xml backends, or an inline-`wsdl` soap backend — since there's
  no gateway to infer it from.
- **Endpoint detail/editor** — five tabs (Basic, Backend, Parameters, Output, Test) inside the panel,
  switched by `switchEndpointTab()`/`initEndpointTabs()`; only the active tab's `.editor-tab-panel` is
  unhidden, so the editor never shows more than one section's fields at once (this replaced an earlier
  always-expanded/collapsible-sections layout that read as cluttered once id/method/path plus four full
  sections were all on screen together). Each tab button carries a live count/summary where useful
  (`#count-backend`, `#count-input`, `#count-output`, refreshed by `refreshSectionCounts()`) so you can
  tell what's inside a tab without opening it. Opening any endpoint (new or existing) always resets to
  the Basic tab. Because a hidden tab's fields can still hold real (invalid) values a submit needs to
  surface, `initEndpointTabs()` also listens for the form's `invalid` event in the capture phase (`invalid`
  doesn't bubble, so a form-level listener needs `true` for the third `addEventListener` argument to see
  it at all) and switches to whichever tab contains the first field the browser flags, before it shows
  the native "please fill out this field" bubble — otherwise that bubble would try to anchor to a field
  the user can't currently see. `renderBackendFields()` swaps in a different field set per backend `type`
  (and the read-only summary for a generated endpoint, above). A generic
  `renderKeyValueEditor()`/`readKeyValueEditor()` pair backs every "list of key/value rows" UI (HTTP
  headers, query params, SOAP args, SQL connection fields, gateway commonParams) — it auto-switches
  an input to `type="password"` when its key looks sensitive, and shows "(unchanged — leave blank to
  keep)" as the placeholder for an already-redacted value rather than ever displaying it. Saving keeps
  the panel open (`saveEndpoint()` re-opens the just-saved id via `openEndpointEditor()` after reloading),
  so the "Delete" button and Test tab are immediately usable on a brand-new endpoint without having to
  reselect it; "Close" (`closeDetail()`) is what actually deselects and shows the placeholder again.
- **Path auto-generation** — an "Auto-generate path from gateway + endpoint id" checkbox
  (`computeAutoBasePath()`/`recomputeAutoPath()`/`setPathAutoMode()`) computes `Path` live as
  `/<gateway-or-backend-type>/<endpoint-id>` plus a separate "Extra path" suffix (also where `:id`-style
  params go). Reopening an existing endpoint re-detects auto mode by checking whether the saved path still
  starts with the recomputed base; a hand-written path that happens to match the pattern will still
  reopen in auto mode — an accepted heuristic ambiguity, since there's no separate persisted flag for
  "how was this path made" (deliberately, to avoid a schema change for a UI-only feature).
- **"Try it" test panel** — `fetchSample()` calls `/admin/api/test-backend` with the form's current
  (unsaved) input/backend config and caches the raw response (`LAST_RAW_SAMPLE`); `applyMappingToSample()`
  then calls `/admin/api/test-mapping` against that cached sample as the output fields are edited,
  without re-hitting the real backend each time.
- **Gateway detail/editor** — `renderGatewayKindFields()` swaps in fields per `kind`; the SQL kind adds
  a "Test connection" button (`testDbConnection()`) and, only when editing an already-saved gateway,
  a "Generate CRUD + procedure endpoints" button (`generateCrudEndpoints()`). Saving keeps the panel open
  the same way the endpoint editor does.
- **Theme toggle** — a switch-style button in the top bar (`toggleTheme()`) flips between light and dark
  by setting `data-theme="light"|"dark"` on `<html>`, persisted in `localStorage` under
  `naimix-admin-theme`. With no stored choice yet, `admin.css` follows the OS's `prefers-color-scheme`
  instead (and keeps listening for OS-level changes via `matchMedia(...).addEventListener("change", …)`
  so the button's own sun/moon icon — driven by a separate `data-effective` attribute the JS keeps in
  sync, `updateThemeToggleIcon()` — stays correct even before the user has made an explicit choice).
  Every color in `admin.css` is a CSS custom property on `:root`, redefined under both the
  `prefers-color-scheme: dark` media query and an explicit `:root[data-theme="dark"]` rule, so the two
  layers can never disagree about which palette is active.
- **Expand/collapse controls** — both the endpoint folder tree and the editor's collapsible sections use
  the same `.chevron-btn` treatment: a 28×28px bordered, rounded square with the arrow glyph inside,
  rather than a bare small character — sized and hit-tested like the rest of the buttons in the UI.
- **Field info icons** — every field label in the endpoint and gateway editors (including
  dynamically-rendered ones, e.g. per-backend-type fields in `renderBackendFields()`/
  `renderGatewayKindFields()`, and repeatable-row fields in `inputParamRow()`/`outputFieldRow()`) carries
  a small round `.info-icon` button (`data-info-key="..."`) immediately after the field's own title word
  (any further descriptive text, e.g. "(optional)", comes after the icon, not before it — so the icon
  always sits right next to what it's explaining). Because a `label` is `flex-direction: column` (see
  Forms below), the title text and the icon (an actual element, not a text run) would otherwise land on
  separate lines — every label's title + icon (+ trailing qualifier) is grouped inside one plain
  `<span class="field-title">`, written directly in `index.html` for static fields and produced by the
  `fieldTitle(...)` helper for every dynamically-rendered one, so the group is a single flex item that
  lays out normally (and wraps naturally) instead of splitting. Clicking an icon opens a shared
  `.info-popup` element via
  the generic `showPopup(anchorEl, content, extraClass?)` helper (created lazily, reused for every popup —
  see also the gateway quick-view below), positioned next to whichever anchor was clicked via
  `getBoundingClientRect()`, flipping above it instead of below when there isn't room underneath.
  `FIELD_INFO` is a flat lookup object mapping each `data-info-key` to its one- or two-sentence
  explanation; `openInfoPopup()` passes that text as `content`. `closeInfoPopup()`/`initInfoIcons()`
  handle toggling (a second click on the same anchor closes it), and closing on outside click, `Escape`,
  window resize, or scroll (capture-phase, so scrolling inside the panel also closes a stale-positioned
  popup). `closeInfoPopup()` is also called from `switchEndpointTab()`, `openEndpointEditor()`,
  `openGatewayEditor()`, and `closeDetail()` so a popup never lingers, mispositioned, across a tab switch
  or panel change.
- **Gateway quick-view** — a "View gateway" button next to the Backend tab's Gateway select
  (`#view-gateway-btn`, disabled whenever Gateway is "(none)", kept in sync by `refreshViewGatewayBtn()`
  which `applyGatewayInferredType()` calls on every gateway change and on editor open) opens the
  currently selected gateway's real definition through the same shared `showPopup()` used by the info
  icons, passing the `"gateway-preview"` modifier class for a wider popup. `buildGatewayPreview()` reads
  straight from the in-memory `GATEWAYS` map (already secret-redacted by the admin API, so it's always
  safe to render as-is) and renders kind, the kind-specific fields (`baseUrl`/`headers` for json/xml,
  `wsdl` for soap, `client`/`connection`/`useNullAsDefault` for sql via the shared `kvList()` helper), and
  `commonParams` — without leaving the endpoint editor to go look the gateway up separately. It shares
  `INFO_POPUP_FOR`/`closeInfoPopup()` with the field-help popups, so opening one closes the other, and it
  closes itself if the user switches Gateway back to "(none)" while it's open.

## Environment variables reference

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the middleware listens on. | `4000` |
| `CONFIG_DIR` | Folder containing both `endpoints/` and `gateways.yaml` (see [Workspace](#workspace)). Only used when no workspace has yet been saved through the admin UI. | unset |
| `ENDPOINTS_DIR` | Directory of endpoint config files, scanned recursively. Ignored once `CONFIG_DIR` or a UI-chosen workspace is in effect. | `config/endpoints` |
| `GATEWAYS_FILE` | Path to the gateways config file. Ignored once `CONFIG_DIR` or a UI-chosen workspace is in effect. | `config/gateways.yaml` |
| `SETTINGS_FILE` | Where the admin-UI-chosen workspace is persisted. Per-machine preference file, not meant for Git. | `data/settings.json` |
| `LOG_LEVEL` | pino log level (`fatal|error|warn|info|debug|trace`). | `info` |
| `ADMIN_TOKEN` | Bearer token required for `/admin/api/*`. **Unset disables the admin API entirely** (503), it does not run unauthenticated. | unset |
| `MAX_REQUEST_BODY_SIZE` | `limit` passed to both `express.json()` and `express.urlencoded()` in `app.ts` -- a string the `bytes` package parses (`"500kb"`, `"1gb"`, …) or a raw byte count. Read directly from `process.env` inside `app.ts` (not threaded through `CreateAppOptions`), same as `ADMIN_TOKEN`/`LOG_LEVEL`. | `10mb` |
| `NODE_ENV` | When `production`, disables the `pino-pretty` dev transport (structured JSON logs instead). | unset |
| `DEMO_JSON_BASE_URL`, `DEMO_XML_BASE_URL`, `DEMO_SOAP_WSDL_URL`, `DEMO_SQLITE_PATH` | Referenced via `${env.X}` by the shipped example `config/gateways.yaml`, pointing at the mock backend. Not meaningful once real gateways replace the demo ones. | see `.env.example` |

Any other `${env.X}` an endpoint or gateway config references must also be set, or config loading fails
fast with a clear error naming the missing variable (`envSubst.ts`).

## Testing strategy

`npx vitest run` — 64 tests across three files as of this writing (`npm test` runs the same thing).

- **`test/middleware.test.ts`** (the integration suite, one real Express `app` + a real mock backend +
  a disposable temp copy of `config/`) — grouped by `describe` block:
  - `health & introspection` — `/healthz`, `/__endpoints`.
  - `JSON backend`, `XML backend`, `SOAP backend`, `SQL backend` — each shipped example endpoint, called
    end-to-end against the real mock backend/SQLite file.
  - `unknown endpoints` — 404 behavior.
  - `admin API auth` — missing/invalid token, and the `ADMIN_TOKEN`-unset-disables-the-API path.
  - `admin API: endpoint CRUD takes effect immediately (no restart)` — create/read/update/delete an endpoint
    through the API and confirm the SAME running `app` instance serves the change on its very next
    request, plus id/path-collision rejection and the path-must-start-with-`/` field-attributed error.
  - `endpoint config files are organized into folders mirroring each endpoint's path` — the folder-layout
    feature specifically: correct nested location with a bracketed param segment, two endpoints sharing a
    path landing in one folder as separate files, a path change moving a file without pruning a folder
    a sibling endpoint still uses, and folder pruning once nothing remains in it.
  - `admin API: test-call endpoints` — `/test-backend`, `/endpoints/:id/test`, `/test-mapping`.
  - `admin API: gateway CRUD` — create/update/delete, redaction, the dependent-endpoint delete-refusal.
  - `admin API: test-connection (DB)` — reachable/unreachable/non-SQL-kind cases.
  - `gateway commonParams + env-sourced input params` — the merge-precedence rules for both
    features, verified against the mock backend's `/echo` endpoint (which reflects back whatever query
    params/headers it received) rather than mocked.
  - `admin API: generate CRUD endpoints for a SQL gateway` — full generation against the 3-table demo
    DB (asserting the exact created-endpoint-id set and the no-primary-key skip message), idempotent
    re-run (second call creates nothing), real filtering/pagination and bulk create/update/delete
    round-trips on the generated endpoints, and malformed-body 400s.
  - `admin API: generate CRUD endpoints -- skip-and-report on a path conflict` — a second gateway
    pointed at the same underlying SQLite file, with a pre-existing hand-written endpoint at a path a
    generated endpoint would also claim, proving generation skips exactly that one conflict while still
    creating everything else.
  - `admin API: workspace switching` — uses its own fully separate `app` + pair of
    registries (never the shared ones the rest of the file depends on, since they'd otherwise be left
    pointed at the wrong workspace for every later `describe` block) against two throwaway folders: one a
    copy of the real project config, one starting empty. Covers `GET /settings` reporting the current
    workspace/counts, `PUT /settings` rejecting a folder that doesn't exist on disk, switching to the empty
    folder loading zero endpoints/gateways without error and updating the live dispatcher immediately,
    switching back restoring the original 7 endpoints, the choice being persisted to `SETTINGS_FILE` (read
    back and asserted directly, not just inferred from behavior), and an endpoint saved while pointed at the
    second folder landing under *that* folder's `endpoints/`, not the first one's.
- **`test/mapper.test.ts`** — unit tests for `mapResponse()`: single-object mapping, `default` on a
  missing source, every `transform`, `output.root` array mapping, and indexing into a top-level array
  with no `root`.
- **`test/paramExtractor.test.ts`** — unit tests for `extractParams()`: extraction+coercion across all
  locations, `default` application, and the `ValidationError` cases (missing required, uncoercible
  number).

**Manual/live-browser QA scripts are disposable and never shipped.** Whenever a change touches the
admin UI (or anything else hard to fully exercise through the API-level test suite alone — e.g. a real
`knex(...).toSQL()` compilation check for a dialect with no live server available in this environment),
a one-off Playwright (or plain `node -e`) script is written, run against a real running instance, and
then **deleted** once it's confirmed passing — never committed. This has repeatedly caught real bugs a
pure API-level test wouldn't (e.g. a CSS specificity bug keeping the login screen visible after sign-in;
an endpoint editor silently destroying a generated endpoint's config when saved with no edits). After any such
manual run against the *real* project config (not a temp test copy), always check `config/endpoints/` for
stray leftover files a failed/interrupted script run might have left behind.

## Runtime requirements and dependencies

For **why** each package below was picked over its available alternatives, see the companion document
[`TECH_STACK.md`](TECH_STACK.md) — this section covers what's used and how; that one covers the
reasoning and trade-offs.

- **Node.js `>=24.0.0`** (enforced via `package.json`'s `engines` field). The project standardized on
  Node 24 (Active LTS until 2028-04-30) rather than chasing per-package compatibility pins, after Node
  20 (this project's original target) reached end-of-life on 2026-04-30. An `npm install` on an older
  Node shows one clear top-level `EBADENGINE` warning for the project itself, rather than scattered
  warnings from individual transitive packages.
- **All five `knex` SQL drivers ship as real dependencies**: `pg`, `mysql2`, `mssql`, `sqlite3`, and
  `better-sqlite3` are all listed in `dependencies` (not just supported by the `client` enum in the
  schema) — `sqlite3` specifically pinned to `^6.0.1` rather than `^5.x`, which pulled in an old
  `node-gyp`/`tar` chain with known vulnerabilities.
- **`knex`** is the SQL query builder/pooling layer underneath the SQL connector — see
  [knexjs.org](https://knexjs.org/) for its own documentation. This project relies on its dialect
  abstraction (one query-builder API across five databases), its `tarn.js`-based connection pooling,
  and its named-`:param` binding support in `.raw()`.
- **`zod`** validates every config file and every admin API request body — `src/config/schema.ts` is
  the source of truth for what's valid.
- **`path-to-regexp@8`** is an explicit dependency (not just Express's own older bundled version) for
  matching an endpoint's `path` pattern against an incoming request — Express 4's bundled version and v8
  have different APIs.
- Key npm packages by area: `axios` (JSON/XML HTTP calls), `fast-xml-parser` (XML parsing), `soap`
  (SOAP client + WSDL), `js-yaml` (endpoint/gateway file format), `jsonpath-plus` (output mapping's
  `source`/`root` expressions), `pino`/`pino-pretty` (structured logging), `express` (HTTP server).
  Dev-only: `vitest` (test runner), `supertest` (HTTP assertions against the Express app without a real
  listening socket), `tsx` (TypeScript execution for `dev`/local scripts), `typescript`.

## Known limitations

- **Output mapping has no computed/concatenated fields or expression language.** `output.fields[]` is
  a 1:1 JSONPath-source-to-dot-path-target mapping with a small fixed `transform` set; there's no way
  to combine two source fields into one output field, or apply arbitrary logic, without a schema
  extension (e.g. a JSONata-style expression field).
- **Data endpoints under `/api/...` (or wherever an endpoint's own `path` points) have no built-in
  authentication of their own** — only `/admin/api/*` is token-gated. Anything an endpoint serves is public
  to whoever can reach the middleware, unless fronted by something else (a reverse proxy, network
  policy, etc.).
- **A single shared `ADMIN_TOKEN`**, not per-user credentials or roles — anyone with the token has full
  admin access (create/edit/delete any endpoint or gateway, including ones that call arbitrary SQL or
  URLs).
- **Generated table-CRUD `list` filtering is exact-match only** — no `>`, `LIKE`, `IN` (beyond the
  special-cased `ids=` parameter), or OR-logic; a real search/filter UI beyond simple equality needs a
  hand-written raw-query endpoint instead.
- **Generated bulk update/delete only ever target rows by their exact, complete primary key** — a
  deliberate safety choice (see [Auto-generated CRUD](#auto-generated-crud--stored-procedure-endpoints)),
  but it does mean there's no generated endpoint for "update every row matching X" — that also needs a
  hand-written raw-query endpoint.
- **The SOAP client cache (`clientCache` in `soap.ts`) never evicts an entry.** A WSDL URL that changes
  at runtime gets a new cache entry rather than replacing the old one in place; the old client object is
  simply never called again but isn't explicitly torn down (acceptable since a SOAP client, unlike a SQL
  connection pool, holds no persistent resource worth explicitly releasing).
- **The admin UI's gateway editor has no dedicated field for a SQL gateway's `pool` settings**,
  even though the schema and connector both support it — it can only be set today by hand-editing
  `gateways.yaml` or a raw `PUT /admin/api/gateways/:name` body.
- **Collapse/expand state in the admin UI (endpoint editor sections, the endpoints folder tree) is in-memory
  only** — it resets on a page reload. Consistent across the whole UI, an accepted simplicity tradeoff.
- **A hand-typed endpoint path that happens to match the auto-generated pattern reopens in "auto" path
  mode** in the endpoint editor, even though it wasn't created that way — there's no separate persisted
  flag distinguishing the two, by design (see [Admin UI and Admin API](#admin-ui-and-admin-api)).
- **"Change workspace" switches the whole running instance, not per-request.** There is no per-request
  workspace/tenant concept — every request to this process (data endpoints and admin API alike) is served
  from whichever single workspace is currently active. This is intentional (see
  [Workspace](#workspace): one process per person, on that person's own machine), but it does mean this
  process is not safe to point two different Git checkouts at "simultaneously" from two browser tabs —
  the second workspace chosen wins for every request until changed again.

## Changelog

Newest first. Each entry names what changed, the key files, and links back to the relevant section
above for the full technical detail.

### 2026-09-16 — Renamed the product from "Lohitas Middleware" to "Naimix"

Padma decided on "Naimix" as the product's name (after considering "Naimish" and ruling it out over a
soft trademark overlap with the existing Naim Audio hi-fi brand and its meaning — Sanskrit for
"momentary"/"transient" — being a poor fit for a server meant to run continuously). Renamed everywhere:
the npm package name (`package.json`/`package-lock.json`, `lohitas-middleware` → `naimix`), the admin
UI's page title/header/brand text (`public/admin/index.html`), the startup log line
(`src/server/index.ts`), and every doc title/prose reference (`README.md`, `TECHNICAL.md`,
`TECH_STACK.md`). Also renamed the internal identifiers that carried the old name so nothing in the
codebase still says "lohitas": the admin UI's `localStorage` keys (`lohitas-admin-token` →
`naimix-admin-token`, `lohitas-admin-theme` → `naimix-admin-theme` — see notes above),  the mock SOAP
backend's WSDL namespace/soapAction URLs (`lohitas.example.com` → `naimix.example.com`, in
`src/mock-backend/customerService.wsdl`), and test-only scratch identifiers in
`test/middleware.test.ts` (`LOHITAS_TEST_USER` env var, `lohitas-test-`/`lohitas-ws-test-` temp-dir
prefixes).

Renaming the two `localStorage` keys means anyone with the admin UI already open will see their saved
token forgotten (re-enter it once) and their theme choice reset to the OS default, on their first load
after this change ships — a one-time, harmless side effect of the rename, not a bug.

The project's own folder (and the built `naimix.zip` deliverable) were renamed to match; nothing else
about the running system's behavior changed.

### 2026-09-03 (same day) — Fixed: "request entity too large" on some endpoints

Padma reported the error for some (not all) endpoints. Root cause: `app.ts` registered
`express.json()`/`express.urlencoded()` with no `limit` option, so both silently fell back to
body-parser's hardcoded default of exactly 100kb — any request body over that, on any endpoint (data
endpoints and the admin API alike), fails with a bare `413 request entity too large` with no indication
of why. "Some endpoints" is explained by which ones happen to send a bigger body: a sizable XML/SOAP
payload, a bulk SQL write with many rows, a large admin UI save.

Fixed by giving both parsers an explicit `limit`, read from a new `MAX_REQUEST_BODY_SIZE` env var
(default `10mb` — confirmed with Padma before implementing) directly inside `app.ts`, the same way
`ADMIN_TOKEN`/`LOG_LEVEL` are already read directly in their own module rather than threaded through
`CreateAppOptions`. Added a regression test (`test/middleware.test.ts`) posting a 200kb body through
`/admin/api/test-mapping` — comfortably over the old 100kb ceiling, comfortably under the new 10mb one —
and confirmed against a standalone Express app that the exact same request against the *old*
(no-`limit`) config reproduces the reported `413`/`"request entity too large"` precisely. Also fixed two
stray "Config folder"/"Change folder…" references in `.env.example` that had survived the 2026-09-02
workspace rename.

### 2026-09-03 — Fixed silent number/boolean coercion in the XML connector; raw responses now logged

Padma asked about letting different users choose XPath vs. JSONPath per their own preference for
XML/SOAP endpoints, since a team checking out the same Git-shared workspace might have people
comfortable with either. Talked through the design at length: a per-endpoint (not per-field, not
global/per-machine) `output.language` choice would have worked mechanically, but Padma weighed it
against the complexity of actually building and maintaining a second query engine and asked what
`fast-xml-parser`'s existing conversion already loses, wanting to preserve the raw XML/SOAP response
either way. Investigating that turned up a concrete, unrelated bug worth fixing regardless of the
XPath decision: `fast-xml-parser`'s default auto-guesses numbers/booleans from tag text, and this
project's own demo XML backend was already hitting it — customer ids stored as the strings `"1"`/`"2"`/
`"3"` in `mock-backend/data.ts` came back as the *numbers* `1`/`2`/`3` once round-tripped through the
XML backend, inconsistent with the same ids over JSON/SQL, and a real "007 becomes 7" hazard for any
id/code that happens to look numeric. Decided against adding XPath (the complexity wasn't worth it for
the actual problem — see [Output mapping engine](#output-mapping-engine)), and instead:

- `src/connectors/xml.ts`: `parseTagValue: false` and `parseAttributeValue: false` added to the
  `XMLParser` config, so every text value comes back exactly as written, as a string — matching the
  JSON/SQL connectors' behavior. A field that genuinely needs a number/boolean still opts in via the
  existing per-field `transform: toNumber`/`toBoolean`.
- `src/connectors/xml.ts` and `src/connectors/soap.ts`: the untouched wire response (`response.data` for
  XML; the `soap` package's own `client.lastResponse` for SOAP) is now logged at debug level right
  before/after parsing, so `LOG_LEVEL=debug` shows the exact response a mapping was evaluated against —
  addresses the "preserve the raw response" half of the original ask without needing a new stored field
  or API surface, since nothing today needs to read it back programmatically.
- `test/middleware.test.ts`: the "XML backend" describe block's assertions updated from numeric
  (`customerId: 2`, `id: 1`) to string (`customerId: "2"`, `id: "1"`) to match the corrected behavior —
  these are also the regression test for this fix, since they're the exact ids that were silently
  miscoerced before.

Verified with `tsc --noEmit`, the full `vitest` suite (64/64 passing), and a live check against the
demo backend confirming `customerId` now comes back as `"2"` over HTTP and that both connectors' debug
logs contain the full, exact raw XML/SOAP envelope text.

### 2026-09-02 — Renamed "config folder" to "workspace" throughout

Padma asked for the concept end users work with gateways and endpoints in — previously labeled "Config
folder" — to be called "Workspace" instead. Applied everywhere: admin UI labels and internal ids
(`index.html`'s "Config folder"/"Change folder…" → "Workspace"/"Change workspace…", the
`#folder-editor`/`#folder-form`/`#change-folder-btn` drawer → `#workspace-editor`/`#workspace-form`/
`#change-workspace-btn`, `admin.js`'s `openFolderEditor()`/`saveFolder()` →
`openWorkspaceEditor()`/`saveWorkspace()`), README.md/TECHNICAL.md section headings and prose (the
"Config folder / workspaces" section is now just "Workspace"), and server-side code comments
(`adminApi.ts`, `app.ts`, `index.ts`, `workspaceSettings.ts`) and test `describe`/`it` text.

Deliberately **not** renamed: the `configDir` field/variable name itself — it's a stable data contract
(the `data/settings.json` shape, the `GET`/`PUT /admin/api/settings` JSON, the workspace-editor form's
`name="configDir"` input) that's independent of what the concept is called in prose, and renaming it
would be a breaking change to the settings file and HTTP API for no user-facing benefit. Also left alone:
the unrelated "endpoint folder" tree grouping in the sidebar (`endpoint-folder-*` classes,
`COLLAPSED_ENDPOINT_FOLDERS`) — that's endpoints grouped by URL path segment, a different concept that
happens to share the word "folder".

### 2026-08-31 (same day) — This checkout's own real workspace packed in

Applied the pattern from the entry directly below to this project's actual working checkout, not just as
a test: the demo `config/` folder was moved aside (`config-demo-backup/`), the real `endpoints/`/
`gateways.yaml` folder was moved in as the new `config/`, and `data/settings.json` was set to
`{"configDir": "config"}`. Confirmed live via `GET /healthz` reporting the correct endpoint count with no
server restart needed. Since the real `gateways.yaml` here has a literal credential rather than an
`${env.*}` reference (see the security note in [Workspace](#workspace)),
added local-only `/config/` and `/config-demo-backup/` entries to this checkout's `.gitignore` — not to
the project template, which still ships the safe, commit-able demo default.

### 2026-08-31 (same day) — Relative `configDir` support, so a checkout can pack its own real workspace in

Follows directly from renaming this project's own checkout folder (twice, in fact) during this session
and having to fix a now-stale absolute `configDir` in `data/settings.json` each time. `resolveStartupPaths()`
(`src/server/index.ts`) now resolves a persisted `configDir` with `path.resolve(process.cwd(), ...)`
before use, so a relative value (e.g. `"config"`, to point at the project's own bundled `config/` folder)
resolves correctly and deliberately rather than only working by coincidence of what `path.join` produces
on an unresolved relative string. The admin UI's "Change workspace" control is unaffected — it already
always saves an absolute path (`adminApi.ts`), since it's meant to point anywhere on disk. See the new
"Packing a real workspace in as the project's own default" note in
[Workspace](#workspace). Verified with `tsc --noEmit` and the full
`vitest` suite (64/64 passing); functionally verified by moving a real `endpoints/`/`gateways.yaml`
folder into `config/`, setting `configDir` to the relative `"config"`, and confirming
`GET /admin/api/settings` reports the correctly-resolved absolute path with the right endpoint/gateway
counts.

### 2026-08-31 — Fixed: info icons landing below the field title instead of beside it

A real layout bug in the previous two entries below, only caught once the user checked it on their own
running instance: every `label` in `admin.css` is `display: flex; flex-direction: column` (title stacked
above its input) — and each *element* child of a flex container becomes its own flex item, while only a
bare, contiguous run of *text* is grouped into one. Since `.info-icon` is a real `<button>` element (not
text), `<label>Id <button class="info-icon">i</button><input></label>` produced three separate flex
items stacked vertically — title, then icon, then input — putting the icon on its own line below the
title rather than beside it, exactly as the checkbox fields never had a problem (`.inline-checkbox`/
`.checkbox-field` already override to `flex-direction: row`, so the whole line is one row regardless of
child count). Fixed by grouping each label's title text + icon (+ any trailing muted qualifier) inside
one plain `<span class="field-title">` — a single flex item that lays out its own contents with normal
inline text flow (wrapping naturally, no further flex needed) — added directly in `index.html` for the
static fields and via a new `fieldTitle(...)` helper in `admin.js` for every dynamically-rendered one
(`renderBackendFields()`, `renderGatewayKindFields()`, `inputParamRow()`, `outputFieldRow()`). Also added
a general (previously `.repeatable-row`-scoped only) `.checkbox-field { flex-direction: row }` rule so
the gateway editor's standalone `useNullAsDefault` checkbox — the one `.checkbox-field` label not living
inside a `.repeatable-row` — gets the same row treatment as the others. See the updated
[Field info icons](#admin-ui-and-admin-api) bullet. Verified with `tsc --noEmit`, the full `vitest` suite
(64/64 passing), and a Playwright pass across the Basic, Backend (json and sql), Parameters, Output, and
gateway-editor screens in both themes confirming every title+icon pair now renders on one line, and that
opening/closing an info popup and the gateway quick-view popup still work correctly with the new markup.

### 2026-08-30 (same day) — Gateway quick-view, and info icons moved next to field titles

Two follow-ups to the field info icons above. First, a few icons had drifted away from the field's own
title word to sit after a parenthetical qualifier instead (e.g. "URL (supports {param} placeholders) ⓘ"
read oddly with the icon at the very end) — every icon now sits immediately after the title itself, with
any qualifier following the icon (e.g. "URL ⓘ (supports {param} placeholders)"); the Backend tab's Type
field similarly now reads "Type (set by the selected gateway) ⓘ" instead of putting the hint after the
icon. Second, a new "View gateway" button next to the Backend tab's Gateway select opens a popup showing
the selected gateway's actual definition (kind, connection details, common params) — see the new
[Gateway quick-view](#admin-ui-and-admin-api) bullet. The popup mechanism itself was generalized
(`showPopup()`) so both the field-help text and this richer, structured gateway view share one popup
element. Verified with `tsc --noEmit`, the full `vitest` suite (64/64 passing), and a Playwright pass in
both light and dark themes covering: the button starting disabled with no gateway selected; a JSON and a
SQL gateway's preview rendering correctly (including a `connection` field list); the popup toggling
closed on a second click; auto-closing when Gateway is switched back to "(none)" or the tab is switched;
and an info-icon popup correctly replacing an open gateway-preview popup (and vice versa).

### 2026-08-30 (same day) — Field info icons in the endpoint and gateway editors

Every field label across both editors — including the ones rendered dynamically per backend/gateway
type and per repeatable row — now has a small "i" icon next to it. Clicking it pops up a short
explanation of what that field is for, in a single reused popup positioned next to the clicked icon;
clicking it again, clicking elsewhere, pressing Escape, resizing, or scrolling all close it. See the new
[Field info icons](#admin-ui-and-admin-api) bullet for the implementation. Verified with `tsc --noEmit`,
the full `vitest` suite (64/64 passing), and a Playwright pass in both light and dark themes covering:
opening a popup from a static field (Basic tab), from a dynamically-rendered backend field (Backend tab,
json type), and from a repeatable Parameters row; toggling closed on a second click, an outside click,
and Escape; and the popup closing automatically on a tab switch.

### 2026-08-30 (same day) — Backend Type is inferred from Gateway instead of asked for separately

The Backend tab used to ask for Type and Gateway as two independent dropdowns, but they were never
really independent: a gateway's `kind` (json/xml/soap/sql) already determines which connector runs the
backend, and picking a Type that disagreed with the selected gateway's kind would just break the
endpoint at request time (wrong connector, wrong expected shape). Gateway now comes first and Type
follows it automatically -- greyed out with a "(set by the selected gateway)" hint -- and is only left
editable when no gateway is selected (a direct URL or inline-wsdl backend). See the updated
[Admin UI and Admin API](#admin-ui-and-admin-api) section. Verified with `tsc --noEmit`, the full
`vitest` suite (64/64 passing), and a Playwright pass confirming: an existing endpoint's Type shows
locked to its gateway's kind; a new endpoint with no gateway keeps Type editable; picking a gateway
snaps Type to match and swaps in the right field set; clearing the gateway back to "(none)" re-enables
Type.

### 2026-08-30 (same day) — Endpoint editor: tabbed layout instead of stacked collapsible sections

The endpoint detail/editor was still cluttered even after the split-pane redesign below — Basic info
plus four sections (Input parameters, Backend, Output mapping, Try it) stacked vertically, mostly
expanded by default. Replaced that with five tabs (Basic, Backend, Parameters, Output, Test) so only one
section's fields show at a time; opening any endpoint always starts on Basic. See the updated
[Admin UI and Admin API](#admin-ui-and-admin-api) section for the `invalid`-event tab-jump detail (a
required field on a non-active tab needs the editor to switch to it before the browser's native
validation bubble tries to show). Verified with `tsc --noEmit`, the full `vitest` suite (64/64 passing),
and a Playwright pass clicking through all five tabs plus the validation-jump case, in both themes.

### 2026-08-30 — Admin UI redesign: split-pane layout, theme toggle, bigger controls

Restructured the admin UI's layout and visual design; no API, schema, or config-file changes. See
[Admin UI and Admin API](#admin-ui-and-admin-api) for the updated technical detail.

- **Split-pane layout** replaces the old tabbed, full-page views. A left sidebar lists Endpoints (the
  existing folder tree) and Gateways (now a row list instead of a table) side by side, always visible.
  Selecting either opens its definition into a detail panel on the right, where it's edited, tested
  (SQL "Test connection", the endpoint "Try it" panel), and saved in place — replacing the old
  slide-in-drawer editors for endpoints and gateways. The "Change workspace…" dialog is the one
  remaining drawer, since it's an app-wide setting rather than a list item.
- **Color theme**: added an explicit light/dark toggle in the top bar (sun/moon switch), on top of the
  existing OS-preference-based dark mode — the toggle remembers the user's choice (`localStorage`) and
  overrides the OS setting; leaving it untouched still follows `prefers-color-scheme` as before.
- **Bigger expand/collapse controls**: the endpoint folder tree's and the editor's collapsible sections'
  chevrons are now 28×28px bordered buttons instead of a small bare glyph, with a visible hover state.
- Verified with `tsc --noEmit`, the full `vitest` suite (64/64 passing, unaffected — these are static
  frontend assets with no server-side test coverage), and a Playwright-driven visual pass against a
  running instance: login → select an endpoint → select a gateway → toggle theme → collapse a section →
  reload (theme persists), screenshotted in both light and dark contexts.

### 2026-08-28 (same day) — Terminology rename: "Connection" → "Gateway", "Route" → "Endpoint"

Renamed the two core concepts throughout the entire codebase for clarity: the named, reusable backend
definition that used to be called a **Connection** is now a **Gateway**, and an individual configured
API endpoint that used to be called a **Route** is now an **Endpoint**. This was a pure rename — no
schema shape, request behavior, or feature changed — applied consistently across every layer:

- **Schema/types** (`src/config/schema.ts`, `src/types/config.ts`): `endpointConfigSchema`
  (was `routeConfigSchema`), `gatewayConfigSchema`/`gatewaysFileSchema` (was
  `connectionConfigSchema`), `EndpointConfigParsed`/`GatewaysFileParsed` types (were
  `RouteConfigParsed`/`ConnectionsFileParsed`).
  An endpoint's `backend.connection: <name>` field is now `backend.gateway: <name>`.
- **Config loader** (`src/config/loader.ts`): `loadEndpointConfigs()`/`loadGateways()`/
  `loadGatewaysRaw()` (were `loadRouteConfigs()`/`loadConnections()`).
- **Server registries/dispatch/admin API**: `src/server/routeRegistry.ts` →
  `src/server/endpointRegistry.ts` (`RouteRegistry` class → `EndpointRegistry`);
  `src/server/connectionsRegistry.ts` → `src/server/gatewaysRegistry.ts` (`ConnectionsRegistry` class →
  `GatewaysRegistry`); `src/server/routeFileLayout.ts` → `src/server/endpointFileLayout.ts`
  (`routePathToFolderSegments()`/`computeRouteFile()` → `endpointPathToFolderSegments()`/
  `computeEndpointFile()`); `src/server/crudGenerator.ts`'s `generateCrudRoutesForConnection()` →
  `generateCrudEndpointsForGateway()`. Admin API paths renamed: `/admin/api/routes` →
  `/admin/api/endpoints`, `/admin/api/connections` → `/admin/api/gateways` (including sub-paths like
  `/admin/api/connections/:name/generate-crud` → `/admin/api/gateways/:name/generate-crud`). The
  introspection endpoint `GET /__routes` → `GET /__endpoints`. Env vars `ROUTES_DIR`/`CONNECTIONS_FILE`
  → `ENDPOINTS_DIR`/`GATEWAYS_FILE`.
- **Admin UI** (`public/admin/`): "Routes tab" → "Endpoints tab", "Connections tab" → "Gateways tab",
  "New route"/"New connection" → "New endpoint"/"New gateway", "Generate CRUD routes" → "Generate CRUD
  endpoints", and the corresponding `admin.js` function/constant renames (`buildRouteTree()` →
  `buildEndpointTree()`, `renderRoutesTree()`/`renderRouteTreeNode()` → `renderEndpointsTree()`/
  `renderEndpointTreeNode()`, `COLLAPSED_ROUTE_FOLDERS` → `COLLAPSED_ENDPOINT_FOLDERS`,
  `renderConnectionKindFields()` → `renderGatewayKindFields()`, `openRouteEditor()` →
  `openEndpointEditor()`, and so on).
- **Tests** (`test/`) and **config data files** under `config/`: `config/routes/` →
  `config/endpoints/`, `config/connections.yaml` → `config/gateways.yaml`.
- **Documentation**: this file, `README.md`, and `TECH_STACK.md` rewritten throughout.

**Two deliberate exceptions, kept as-is:**

1. A SQL gateway's config shape still has a *nested* field literally named `connection` (e.g.
   `client`/`connection`/`pool`/`useNullAsDefault` under `kind: sql`) — that's knex's own required
   config shape for the database driver (host/user/password/database/filename, passed straight
   through), not this project's renamed entity concept, so it keeps knex's own field name even though
   the gateway that contains it was renamed. See [Gateway config reference](#gateway-config-reference)
   and [SQL connector](#sql-connector).
2. The admin UI's "Test connection" button and its underlying `testDbConnection()` (frontend),
   `testSqlConnection()` (`sql.ts`), and `GatewaysRegistry.testConnection()` method name are unchanged —
   "connection" there is generic reachability-testing terminology (as in "test the database
   connection"), not a reference to the renamed entity, so the wording and identifiers were left alone.

Verified: `tsc --noEmit`/`npm run build` clean, full `vitest` suite green, and a manual QA pass against a
running instance (served admin UI static assets, plus the full API surface — endpoint/gateway CRUD,
generate-crud, and all four live backend types) confirmed the new terminology end to end. The project
config used for that pass was restored to its original state afterward.

### 2026-08-28 — Workspace: point each instance at its own Git checkout

Padma asked for a way for each user to select the folder their endpoints/gateways are defined in, since
every user runs their own instance and works from their own folder. Clarified scope first: this project
runs one process per person on that person's own machine (no login, no multi-tenant serving), and teams
share endpoints/gateways through a **Git repo** that each person checks out locally and points their own
instance at — the app itself never touches Git (no clone/commit/push from inside it).

- New concept **"workspace"** (first shipped as "config folder", renamed later — see the 2026-09-02
  entry above): any folder containing (or that will contain) an `endpoints/` subfolder and a
  `gateways.yaml` file, matching this project's own `config/` layout —
  `resolveConfigDir()` in the new `src/server/workspaceSettings.ts`.
- `EndpointRegistry`/`GatewaysRegistry` (`endpointRegistry.ts`/`gatewaysRegistry.ts`) gained
  `getDir()`/`setDir()` and `getFilePath()`/`setFilePath()` — their backing path is now a mutable
  instance field (was `readonly`), so the *same* instances every other module already holds a reference
  to can be repointed at a different folder and reloaded in place, with the change visible to every
  consumer (`dispatch.ts`, `adminApi.ts`) on the very next request.
- New admin API endpoints `GET`/`PUT /admin/api/settings` (`adminApi.ts`) — `PUT` validates the folder
  exists on disk (`400` if not, naming the path), calls `closeAllSqlConnections()` to release any pooled
  SQL clients tied to the *old* workspace's gateways before switching, repoints both registries, and
  persists the choice via `saveWorkspaceSettings()`.
- `src/server/index.ts`'s startup path resolution now checks, in order: a workspace persisted from a
  previous admin-UI choice (`SETTINGS_FILE`, default `data/settings.json` — deliberately outside any
  workspace so it survives being swapped for a different one, and gitignored as a per-machine
  preference) → `CONFIG_DIR` env var → the original independent `ENDPOINTS_DIR`/`GATEWAYS_FILE` env
  vars, unchanged, as the final fallback.
- Admin UI: a new workspace bar under the header (`renderWorkspaceBar()` in `admin.js`, markup in
  `index.html`, styling in `admin.css`) shows the current workspace and endpoint/gateway counts; "Change
  workspace…" opens a one-field drawer (`#workspace-editor`) that calls `PUT /admin/api/settings`,
  following the same `save-then-close-then-reload` order already used by the endpoint/gateway editors.
- See [Workspace](#workspace) for the full design (including why a
  brand-new, still-empty folder works with no extra step, and why switching affects the whole running
  process rather than being per-request).

Verified: extended vitest by 5 tests in a fully separate `describe` block using its own throwaway app +
registries (never the shared ones the rest of the suite depends on) — 64/64 total, `tsc --noEmit`/
`npm run build` clean. Also ran a dedicated 7-check live-browser Playwright script (not shipped, per the
project's disposable-QA-script convention) against a real running instance: workspace bar shows the
right folder/counts, switching to an empty folder empties the Endpoints tab immediately with no restart,
switching back restores all 7 endpoints, and a nonexistent folder shows a clear inline error without
closing the drawer — all 7 passed; screenshot confirmed clean rendering.

### 2026-08-27 (same day) — `TECH_STACK.md` created

- New companion document, [`TECH_STACK.md`](TECH_STACK.md), explaining why each major
  package/framework in this project was chosen over its realistic alternatives (Express vs
  Fastify/Koa/Hono, Zod vs Joi/ajv, Knex vs Prisma/Drizzle/Kysely, Axios vs native `fetch`, pino vs
  winston, vitest vs jest, and more), plus a set of general principles for future dependency
  decisions. Linked from [Runtime requirements and dependencies](#runtime-requirements-and-dependencies)
  above. Keep it updated alongside this file whenever a dependency is added, replaced, or upgraded for
  a real (non-routine) reason.

### 2026-08-27 — Endpoint configs reorganized into folders mirroring path; this document created

- `config/endpoints/` reorganized from one flat directory of `<id>.yaml` files into nested folders
  mirroring each endpoint's own URL path (new `src/server/endpointFileLayout.ts`; `EndpointRegistry.upsert()`/
  `remove()` in `endpointRegistry.ts` rewritten to move files and prune empty folders correctly;
  `loader.ts`'s file discovery made recursive). The 7 pre-existing endpoints were migrated in place. The
  admin UI's Endpoints tab now renders the same structure as a collapsible folder tree instead of a flat
  table. See [Folder layout mirrors each endpoint's path](#folder-layout-mirrors-each-endpoints-path).
- Added 4 new tests covering the move/prune logic specifically; a disposable Playwright script verified
  the new folder-tree UI, then was deleted per convention.
- This `TECHNICAL.md` file was created as the project's living internals reference, to be kept current
  with every future change (this changelog entry is itself the first case of that).

### 2026-08-26 (same day) — MySQL `information_schema` column-casing bug in CRUD generation

- A real MySQL server hit `Undefined binding(s) detected when compiling SELECT` while running "Generate
  CRUD endpoints" — the untested-live-server risk flagged when the CRUD-generation feature (below) first
  shipped. Root cause: an *unaliased* `information_schema` column's JS-object-key casing isn't
  guaranteed consistent across MySQL servers/versions, so a destructured value came back `undefined`
  and tripped knex's own undefined-binding safety check on the next query.
- Fix: every `information_schema` `.select(...)` across `introspectPg`/`introspectMysql`/
  `introspectMssql` in `src/connectors/sqlIntrospect.ts` now uses knex's object-alias form
  (`.select({ alias: "column" })`), which the SQL standard guarantees controls the returned field name —
  applied to all three untested dialects at once, not just the one MySQL column that was reported,
  since the same fragility existed in the other two. Verified via `knex(...).toSQL()` compiled-SQL
  inspection (no live pg/mysql/mssql server available in this environment). See
  [SQL connector](#sql-connector) → "SQL introspection".

### 2026-08-26 — Auto-generated table-CRUD + stored-procedure endpoints

- New feature: a "Generate CRUD endpoints" action that introspects a SQL gateway and creates
  list/bulk-create/bulk-update/bulk-delete endpoints for every table, plus one endpoint per stored procedure
  where the dialect supports it. New files: `src/connectors/sqlIntrospect.ts`,
  `src/server/crudGenerator.ts`; extended `sqlBackendSchema`/`SqlBackendConfig` with the generated
  table-CRUD and stored-procedure modes; extended `ConnectorContext` with `rawQuery`/`rawBody`; new
  admin endpoint `POST /admin/api/gateways/:name/generate-crud`. See
  [Auto-generated CRUD + stored-procedure endpoints](#auto-generated-crud--stored-procedure-endpoints) and
  [SQL connector](#sql-connector).
- Caught and fixed a real bug before shipping: the endpoint editor's SQL backend field renderer would have
  silently destroyed a generated endpoint's config if saved with zero edits (see
  [Auto-generated CRUD](#auto-generated-crud--stored-procedure-endpoints) for the fix).
- Mock DB schema extended with a `notes` table (non-`id`-named primary key) and a `tags` table (no
  primary key) for real multi-shape test coverage.
- Flagged in the README/this document that the pg/mysql2/mssql introspection paths were unverified
  against a live server (only SQLite was available) — validated by the MySQL bug entry directly above.

### 2026-08-26 — All 5 SQL drivers shipped as real dependencies

- `sqlGatewaySchema`'s `client` enum listed `pg`/`mysql2`/`mssql`/`sqlite3`/`better-sqlite3`, but
  only `better-sqlite3` was an actual `package.json` dependency — the other four would have failed with
  a "Cannot find module" error at connect time despite being schema-valid. Added all four as real
  dependencies (`sqlite3` pinned to `^6.0.1` to avoid a vulnerable older `node-gyp`/`tar` chain pulled
  in by `^5.x`). See [Runtime requirements and dependencies](#runtime-requirements-and-dependencies).

### 2026-08-26 — Three fixes: mandatory gateway URL, collapsible endpoint editor, DB Test Connection

- `baseUrl` (json/xml) and `wsdl` (soap) changed from optional to required in the schema and types.
- Found and fixed a related bug: `gatewayConfigSchema`'s plain `z.union` validation failures
  surfaced as one opaque top-level error with no field attribution — added
  `parseGatewayConfig()` in `gatewaysRegistry.ts` to pick out the right branch's real field
  issues. See [Admin UI and Admin API](#admin-ui-and-admin-api).
- Endpoint editor sections (Input parameters/Backend/Output mapping/Try it) made collapsible with live
  item counts in each header.
- Added a "Test connection" button/endpoint for SQL gateways (`testSqlConnection()` in `sql.ts`,
  `POST /admin/api/gateways/test-connection`), using a standalone throwaway knex instance. See
  [SQL connector](#sql-connector).

### 2026-08-26 — Path auto-generation, `in: "env"` input params, gateway `commonParams`

- Admin UI: an endpoint's `Path` can auto-compute from its gateway + endpoint id, with a separate "extra
  path" suffix for path params. Pure frontend feature, no schema change. See
  [Admin UI and Admin API](#admin-ui-and-admin-api).
- New input param location `in: "env"`, sourced from `process.env` rather than the caller's request —
  `paramExtractor.ts`. See [Endpoint config reference](#endpoint-config-reference).
- New gateway-level `commonParams`, merged under every endpoint call's resolved params as the
  lower-precedence layer. See [Gateway config reference](#gateway-config-reference).
- Added a `GET /echo` endpoint to the mock backend to verify both features end-to-end against real
  resolved values rather than mocks.

### 2026-08-25 — Admin UI: unhelpful endpoint-path validation error

- A missing leading `/` on an endpoint's `path` produced a raw Zod message with no indication of which
  field was wrong. Fixed the admin UI's error display to read `issues[].path`, added an inline hint +
  HTML `pattern` on the Path field, and locked in the response shape with a dedicated test.

### 2026-08-25 — EBADENGINE dependency fix, then reversed in favor of standardizing on Node 24

- Initially pinned `soap`/`vite` to older versions to satisfy Node 20; same day, reconsidered and
  standardized the whole project on Node 24 (Active LTS) instead, reverting the pins and setting a hard
  `engines: { node: ">=24.0.0" }`. See
  [Runtime requirements and dependencies](#runtime-requirements-and-dependencies).

### 2026-08-25 — Admin UI

- Full browser admin UI added at `/admin`, backed by a token-gated `/admin/api/*` REST API. Required a
  real architecture change: replaced static per-endpoint Express handler registration with the
  `EndpointRegistry`/`GatewaysRegistry` + dynamic dispatcher design described throughout this document,
  which is what makes every admin-API mutation take effect immediately. See
  [Hot-reloadable registries](#hot-reloadable-registries), [Request lifecycle](#request-lifecycle), and
  [Admin UI and Admin API](#admin-ui-and-admin-api).

### 2026-08-24 — Initial build

- Node.js/TypeScript middleware connecting to SOAP, XML, JSON, and SQL backends, config-driven via
  YAML/JSON endpoint files and a shared gateways file, with declarative JSONPath-based output mapping.
  The architecture described in [System overview](#system-overview) through
  [Output mapping engine](#output-mapping-engine) is this initial design, subsequently extended (but
  not fundamentally changed) by every entry above.
