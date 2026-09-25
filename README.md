# Naimix

A configurable middleware server that sits in front of heterogeneous backends
(JSON REST APIs, SOAP services, generic XML-over-HTTP services, and SQL
databases), calls them with parameters supplied by the caller, reshapes the
response according to a declarative mapping, and always responds with JSON.

Every backend integration is defined in a config file, not code: to add a
new endpoint you write an endpoint file describing the backend to call, the
input parameters it accepts, and how to map the backend's response onto the
JSON you want to return.

## Requirements

Node.js **24.x or later** (Active LTS as of 2026; supported until April
2028 — see the [Node.js release schedule](https://github.com/nodejs/Release)).
Node 20.x reached end-of-life on 2026-04-30 and no longer receives security
patches, so this project targets Node 24 rather than pinning dependencies
down to stay compatible with it. Run `node -v` to check your current
version; if you're on an older Node, install 24 via
[nvm](https://github.com/nvm-sh/nvm) (`nvm install 24 && nvm use 24`) or
from [nodejs.org](https://nodejs.org/).

If `npm install` ever reports `EBADENGINE` warnings, it means either your
local Node is older than `24.0.0` (the `"engines"` field in `package.json`
will say so directly), or a dependency's own floating `^` range resolved to
a newer release that quietly raised *its* minimum Node version further
still — check `npm view <package> engines` across recent versions to see
when it happened, and either pin that one dependency down or upgrade Node
further, whichever fits.

## Quick start

```bash
npm install
cp .env.example .env

# Terminal 1: a demo backend exposing the same data as JSON, XML, SOAP, and SQLite
npm run mock-backend

# Terminal 2: the middleware itself, serving the endpoints in config/endpoints/
npm run dev
```

Then try the bundled examples:

```bash
curl http://localhost:4000/api/json/customers/1
curl http://localhost:4000/api/json/customers
curl http://localhost:4000/api/xml/customers/2
curl http://localhost:4000/api/xml/customers
curl http://localhost:4000/api/soap/customers/3
curl http://localhost:4000/api/sql/customers/1
curl http://localhost:4000/api/sql/customers
curl http://localhost:4000/__endpoints      # what's currently registered
curl http://localhost:4000/healthz       # status + endpoint count

# A demo endpoint requiring caller authentication (see "Caller authentication" below)
curl -X POST http://localhost:4000/auth/login/demoLogin \
  -H 'Content-Type: application/json' -d '{"username":"demo","password":"demo123"}'
# -> {"token":"<opaque session token>","expiresAt":1234567890000}
curl http://localhost:4000/api/authed/echo -H 'Authorization: Bearer <token from above>'
```

Run `npm run build && npm start` for a compiled run of the full app (admin
console + data plane together, the same as `npm run dev`) -- this is the
`dev` target; see "Deploying to QA/Production" below for the separate
`qa`/`prod` targets, which never include the admin console at all. `npm
test` runs the automated test suite (it spins up its own copy of the mock backend, so
no manual setup is required).

To create and edit endpoints visually instead of hand-writing YAML, set
`ADMIN_TOKEN` in `.env` and open `http://localhost:4000/admin` — see
[Admin UI](#admin-ui) below.

## How it works

```
incoming request
      │
      ▼
endpoint config match (method + path)
      │
      ▼
extract & validate input params (path / query / header / body)
      │
      ▼
call the configured backend (json | xml | soap | sql), substituting params
      │
      ▼
map the raw backend response onto the output shape (JSONPath + rename/transform)
      │
      ▼
JSON response
```

Endpoint configs live under `config/endpoints/` (`.yaml` or `.json`, one file per
endpoint) and are loaded recursively at startup, however deep they're
nested. Shared backend gateway details (base URLs, WSDL locations, DB
credentials) live once in `config/gateways.yaml` and are referenced by
name from endpoint configs, so credentials aren't duplicated or scattered
across files.

### Folder layout mirrors each endpoint's path

`config/endpoints/` is organized into nested folders that mirror each endpoint's
own URL path, rather than being one flat directory of `<id>.yaml` files.
For example, an endpoint at `/api/customers/:id` is stored at
`config/endpoints/api/customers/[id]/<endpoint-id>.yaml` -- the `:id` path
parameter becomes a `[id]` folder (square brackets are filesystem-safe on
every OS; `:` isn't, on Windows). Endpoints that share a path but differ by
HTTP method (e.g. a generated table's GET/POST/PATCH/DELETE, all at
`/api/<gateway>/<table>`) land in the same folder, one file per endpoint id.

This is purely a storage convenience -- request matching only ever looks at
the `path` field parsed out of an endpoint's YAML, never at where the file
happens to live on disk, so moving files around (by hand, or automatically
whenever the admin UI saves an endpoint whose path or id changed) can never
change runtime behavior. The admin UI's Endpoints list shows the same
structure as a collapsible folder tree, so endpoints with same the top-level
path segment (`/api`, `/api/xml`, etc.) group together instead of being one
long flat list.

Saving an endpoint through the admin UI (or the `/admin/api/endpoints` endpoints)
always writes to the correct nested location for its current path/id, moves
the file if either one changes, and prunes any folder left empty afterward
-- there's nothing to do by hand. Hand-editing files directly on disk still
works too; the folder they're placed under doesn't need to be right (the
loader finds every `.yaml`/`.json` file recursively regardless of where it
sits), it's just where the admin UI will file its own copy the next time
that endpoint is saved.

## Endpoint config reference

```yaml
id: get-customer                 # unique id, used in logs/introspection
description: "Optional human-readable description"
method: GET                      # GET | POST | PUT | PATCH | DELETE
path: /api/customers/:id         # Express-style path (supports :params)

input:                           # parameters this endpoint accepts
  - name: id
    in: path                     # path | query | header | body | env
    required: true
    type: string                 # string | number | boolean
    default: null                # optional; used when the param is absent
    description: "Customer id"
  - name: apiKey                 # in: env -- sourced from process.env, not the caller.
    in: env                      # Callers never supply or see this; useful for a shared
    envVar: BACKEND_API_KEY      # secret every call needs. envVar defaults to `name`
    required: true                # if omitted (so `in: env` with just `name: apiKey`
                                   # reads process.env.apiKey).

backend:                         # exactly one of: json | xml | soap | sql
  type: json
  gateway: crmJson            # optional; see config/gateways.yaml
  url: "/customers/{id}"         # {paramName} is substituted from `input`
  method: GET
  headers: { }
  query: { }
  body: null
  timeoutMs: 10000

output:
  root: null                     # optional JSONPath selecting an array (see below)
  fields:
    - target: customerId         # dot-path in the JSON you return
      source: $.id                # JSONPath into the backend response
      default: null               # used when `source` has no match
      transform: null             # toString | toNumber | toBoolean | trim | upper | lower
```

`target` supports nested paths (`name.first`) and array indices
(`tags[0]`), so a flat backend response can be reshaped into nested JSON.

### Single object vs. array responses

- Omit `output.root` to return a single JSON object: each `source` is a
  JSONPath evaluated against the whole backend response (use `$[0].field`
  if the backend itself returns a top-level array, as SQL connectors do).
- Set `output.root` to a JSONPath selecting an array (e.g. `$.items[*]` or
  `$[*]`) to return a JSON array: each matched item is mapped independently
  using the same `fields`.

### Backend types

**`json`** -- calls a JSON REST endpoint with `axios`. `url`, `headers`,
`query`, and `body` all support `{paramName}` substitution. When `gateway`
has a `baseUrl`, a relative `url` is appended to it.

```yaml
backend:
  type: json
  gateway: crmJson
  url: /customers/{id}
  method: GET
```

**`xml`** -- calls a plain XML-over-HTTP endpoint and parses the response
with `fast-xml-parser` into a plain object before mapping. `body` is an XML
string template (also supports `{paramName}`).

```yaml
backend:
  type: xml
  gateway: crmXml
  url: /customers/{id}/xml
  method: GET
```

The parsed object mirrors the XML tag nesting, rooted at the outermost tag --
`<customer><id>2</id></customer>` becomes `{ customer: { id: "2" } }`, so a
`source` for it starts `$.customer...`. Attributes get an `@_` prefix (e.g.
`$.customer['@_id']`), and repeated sibling tags (e.g. multiple `<item>`s
under `<items>`) become a JS array automatically -- map those with
`output.root` exactly like a JSON or SQL collection (see
`config/endpoints/xml-customers-list.yaml`). One caveat: `fast-xml-parser` only
produces an array when a tag repeats 2+ times in a given response, so if your
real backend can return exactly one item for a collection endpoint, make sure
it still wraps that single item the same way (most well-behaved APIs do).
Every text value comes back exactly as written in the XML, as a string --
add `transform: toNumber`/`toBoolean` on a field if you actually want a
number/boolean rather than the text as-is (see [Endpoint config
reference](#endpoint-config-reference)'s `transform` list).

**`soap`** -- calls a SOAP operation via a WSDL using the `soap` client
library. `args` values support `{paramName}` substitution. Because many
WSDLs advertise an internal/stale `<soap:address>`, the actual endpoint
called defaults to the WSDL URL with its query string stripped (override
with `endpoint` if that default is wrong for your service).

```yaml
backend:
  type: soap
  gateway: crmSoap
  operation: GetCustomer
  args:
    CustomerId: "{id}"
  # endpoint: https://real-service.example.com/CustomerService   # optional override
```

**`sql`** -- runs a parameterized query via `knex`. Five database clients are
supported out of the box (their driver packages are already listed in
`package.json`, so no extra install is needed):

| `client` value    | Database                              |
| ----------------- | -------------------------------------- |
| `pg`               | PostgreSQL                            |
| `mysql2`           | MySQL / MariaDB                       |
| `mssql`            | Microsoft SQL Server                  |
| `sqlite3`          | SQLite                                |
| `better-sqlite3`   | SQLite (faster, synchronous driver)   |

Use named `:param` bindings that match your declared `input` parameter names.

```yaml
backend:
  type: sql
  gateway: demoDb
  query: "SELECT id, first_name, last_name FROM customers WHERE id = :id"
```

This hand-written `query` form is one of three SQL backend modes; the admin
UI's "Generate CRUD + procedure endpoints" button produces the other two
(table-based bulk CRUD, and stored-procedure calls) automatically -- see
"Auto-generated CRUD + stored-procedure endpoints" below.

### Environment-sourced input parameters (`in: env`)

A parameter declared `in: env` is never read from the caller's request at
all -- it's resolved from this process's own `process.env` at request time,
using `envVar` (or `name`, if `envVar` is omitted) as the variable name. This
is for values every call needs that callers shouldn't have to supply (or be
able to override): a shared backend API key, a fixed tenant id, an internal
service token. It plays by the same `required`/`default`/`type` rules as
every other location -- a `required: true` env param whose variable isn't
set fails the request with a 400, same as a missing required path param
would. In the admin UI's "Try it" test panel, an env param's test-value box
is an optional override; leaving it blank uses the real environment value,
same as a live request would.

## Gateways config reference (`config/gateways.yaml`)

`baseUrl` (json/xml) and `wsdl` (soap) are required on every gateway --
a gateway with no idea where its backend lives isn't useful, so both the
schema and the admin UI enforce it (the UI's Base URL/WSDL URL field is
marked required, and saving without one fails with a clear `baseUrl:
Required` / `wsdl: Required` error). An endpoint can still point at a fully
custom, absolute URL/WSDL of its own without going through any gateway
at all -- this requirement only applies once you do create a gateway.

```yaml
gateways:
  crmJson:
    kind: json
    baseUrl: ${env.CRM_BASE_URL}
    headers:
      Authorization: "Bearer ${env.CRM_TOKEN}"
    commonParams:                 # available as {name} to every endpoint using this gateway
      tenant: acme                # an endpoint's own `input` param of the same name wins if both exist
      region: ${env.DEPLOY_REGION}  # values support ${env.X} substitution, same as any other field

  crmSoap:
    kind: soap
    wsdl: ${env.CRM_WSDL_URL}

  mainDb:
    kind: sql
    client: pg                    # or mysql2 | mssql | sqlite3 | better-sqlite3
    connection:
      host: ${env.DB_HOST}
      user: ${env.DB_USER}
      password: ${env.DB_PASSWORD}
      database: ${env.DB_NAME}

  crmJsonAuthed:
    kind: json
    baseUrl: ${env.CRM_BASE_URL}
    requiresAuth: myProvider      # see "Caller authentication" below
```

`${env.VAR_NAME}` is resolved once at startup against `process.env` (loaded
from `.env` via `dotenv`), so secrets never need to be committed to config
files -- only the variable name does.

### Gateway-level `commonParams`

`commonParams` is a flat set of name/value defaults every endpoint using that
gateway can reference as `{name}` in its backend config (URL, headers,
query, SOAP args, SQL bind params -- anywhere `{paramName}` substitution
already applies), without redeclaring them per endpoint. They're merged in
*underneath* the endpoint's own resolved input params, so an endpoint that declares
its own `input` param with the same name (from the request, or `in: env`)
overrides the gateway's default for that one call; every other endpoint on
the same gateway still gets the shared default. This is the place for
something every endpoint on a gateway needs -- a tenant id, a region, an
account key -- as opposed to `in: env` on a specific endpoint's own `input`,
which is scoped to just that one endpoint.

## Caller authentication (`config/authProviders.yaml`)

**Status: phases 1-2 of a larger design.** This covers a bespoke backend
login API (`basicLogin`), a standard OAuth2 token endpoint's password/
client_credentials grants (`oauth2`), and LDAP/Active Directory plain simple
bind (`ldap`). SAML and the OAuth Authorization Code (browser redirect) flow
are designed but not yet implemented -- see `AUTH_DESIGN_NOTES.md` for the
full design and what's still ahead.

This is authentication for the middleware's *own data endpoints* (the ones
under `/api/...` you define) -- a separate, independent system from
`ADMIN_TOKEN`, which only ever gates `/admin/api/*` (configuring this
instance). A caller here never sees or handles the real backend credential;
this middleware logs in on their behalf, holds the resulting backend token
server-side, and hands the caller its own opaque session token instead.

**How it fits together:**

1. Define one or more named providers in `config/authProviders.yaml`:

   ```yaml
   authProviders:
     myProvider:
       kind: basicLogin                       # a bespoke login API
       loginUrl: ${env.BACKEND_LOGIN_URL}
       tokenPath: $.accessToken                # JSONPath into the login response
       refreshTokenPath: $.refreshToken        # optional
       expiresInPath: $.expiresIn              # optional (seconds until expiry)

     myOAuthProvider:
       kind: oauth2                            # a standard RFC 6749 token endpoint
       tokenUrl: ${env.BACKEND_TOKEN_URL}
       grantType: password                     # or client_credentials
       clientId: ${env.BACKEND_CLIENT_ID}
       clientSecret: ${env.BACKEND_CLIENT_SECRET}

     myLdapProvider:
       kind: ldap                              # LDAP/AD plain simple bind
       url: ${env.LDAP_URL}                    # e.g. ldap://localhost:3389 or ldaps://ad.example.com:636
       # Search-then-bind mode (the realistic AD/enterprise pattern): a
       # service account searches for the real user DN, then binds as that
       # user with their own password. See LdapProviderConfig in
       # src/types/config.ts for the alternative direct-bind mode
       # (userDnTemplate), used instead when usernames map predictably to a
       # DN -- exactly one of the two modes may be configured.
       bindDn: cn=admin,dc=example,dc=com
       bindPassword: ${env.LDAP_BIND_PASSWORD}
       searchBase: ou=people,dc=example,dc=com
       searchFilter: (uid={username})          # (sAMAccountName={username}) for Active Directory
       groupSearchBase: ou=groups,dc=example,dc=com   # optional -- omit to skip group lookup
       groupSearchFilter: (member={dn})
       attributes: [mail, title]                # optional extra directory attributes -> claims.attributes
       tokenSecret: ${env.LDAP_TOKEN_SECRET}   # signs the stand-in backend token -- see below
   ```

   LDAP/AD has no native token to hand a downstream backend, so on a
   successful bind `ldap` mints its own signed JWT (HS256, via `tokenSecret`)
   as the stand-in backend token -- containing `sub` (the resolved user DN),
   `username`, and `groups` (when group lookup is configured) -- and injects
   it via `{__authToken}` exactly like any other provider's real token. Any
   backend that separately trusts this middleware (i.e. is configured with
   the same secret) can verify that JWT itself. There's no `refresh`: LDAP
   has no refresh concept, so an expired `ldap` session just means a clean
   401 asking the caller to log in again, same as `basicLogin`. See
   `docker/openldap/README.md` for a free local test directory to develop
   and try this against (seeded with users `jdoe`/`asmith`/`bwayne`,
   password `password123`).

2. Add `requiresAuth: myProvider` to any gateway (see "Gateways config
   reference" above) -- every endpoint that calls through it now requires a
   caller session issued by exactly that provider.

3. A caller logs in once: `POST /auth/login/myProvider` with
   `{ "username": "...", "password": "..." }` (the `password` grant and
   `basicLogin` both take these; `client_credentials` takes no end-user
   credentials at all, since it authenticates the middleware itself, not a
   person). The response is `{ "token": "<opaque token>", "expiresAt": ... }`
   -- this token is meaningless outside this middleware; store it and send
   it as `Authorization: Bearer <token>` on every subsequent call to an
   endpoint whose gateway requires that same provider.

4. Behind the scenes, the middleware injects the real backend token it
   obtained as a reserved `{__authToken}` param -- reference it in the
   gateway's own config exactly like any other `{param}`, e.g.:

   ```yaml
   gateways:
     crmJsonAuthed:
       kind: json
       baseUrl: ${env.CRM_BASE_URL}
       requiresAuth: myProvider
       headers:
         Authorization: "Bearer {__authToken}"
   ```

5. `POST /auth/logout` (with the same bearer token) invalidates the session
   immediately -- opaque tokens are a server-side lookup, so revocation is
   instant, no waiting for a JWT to expire.

A session past its provider-reported expiry is refreshed automatically
(a little before expiry, not after) when the provider supports it --
`oauth2` does, via the standard `refresh_token` grant; `basicLogin` doesn't
in this phase, so an expired `basicLogin` session just means a clean 401
asking the caller to log in again. Sessions live in this process's own
memory (fine for one instance; see `AUTH_DESIGN_NOTES.md` for why a
multi-instance production deployment needs a shared store instead).

Manage providers the same way as gateways -- an **Auth providers** section in
the admin UI's sidebar (list/create/edit/delete, with the same "blank field
means unchanged" convention for `clientSecret`), or directly via
`/admin/api/auth-providers` (`GET`/`POST`/`PUT`/`DELETE`). A gateway's own
editor has a **Requires auth** dropdown, populated from this list, that sets
its `requiresAuth` field. Deleting a provider still required by a gateway is
refused (409), same as deleting a gateway an endpoint still uses.

## Auto-generated CRUD + stored-procedure endpoints

For a SQL/database gateway, the admin UI can introspect the actual
database and generate endpoints for you instead of hand-writing one YAML file
per table. Open the gateway (it must already be saved) and click
**"Generate CRUD + procedure endpoints"**. This never overwrites or fails on a
conflict -- an id or `method`+`path` already in use (hand-written, or from an
earlier generation) is skipped and reported, so it's always safe to run
again later, e.g. after adding a table.

**Per table**, at `/api/<gateway>/<table>`:

| Method  | Endpoint id suffix | What it does |
|---------|------------------|--------------|
| `GET`   | `-list`          | Lists/filters rows. |
| `POST`  | `-create`        | Bulk-inserts rows. |
| `PATCH` | `-update`        | Bulk-updates rows by primary key. |
| `DELETE`| `-delete`        | Bulk-deletes rows by primary key. |

A table with **no primary key** only gets `-list` and `-create` -- there's no
reliable way to target a specific row for update/delete without one.

`GET` (list) reads filters from the query string, not the declarative
`input` params every hand-written endpoint uses (there'd be far too many to
declare per table): any real column name does an exact-match filter (e.g.
`?status=ACTIVE`), plus `limit`/`offset` (pagination; default limit 100, max
1000), `sort`/`order` (`asc`/`desc`), and -- for a table with a single-column
primary key -- `ids=1,2,3` to fetch a specific set of rows in one request.
Unrecognized query keys are silently ignored rather than erroring, so
`?foo=bar` on a table with no `foo` column just has no effect.

`POST`/`PATCH`/`DELETE` (bulk create/update/delete) read a whole array from
the JSON body -- rows/updates/keys are identified by primary key, never by an
open-ended filter, so a typo can't accidentally touch more rows than
intended:

```jsonc
// POST /api/mainDb/customers -- bulk create
{ "rows": [ { "first_name": "Ada", "status": "ACTIVE" }, { "first_name": "Grace", "status": "ACTIVE" } ] }
// -> { "insertedCount": 2, "rows": [...] }  ("rows" is null on mysql2/sqlite -- see note below)

// PATCH /api/mainDb/customers -- bulk update, one entry per row
{ "updates": [ { "key": { "id": 1 }, "fields": { "status": "INACTIVE" } }, { "key": { "id": 2 }, "fields": { "status": "ACTIVE" } } ] }
// -> { "updatedCount": 2, "results": [ { "key": {...}, "matched": 1 }, ... ] }

// DELETE /api/mainDb/customers -- bulk delete
{ "keys": [ { "id": 1 }, { "id": 2 } ] }
// -> { "deletedCount": 2, "results": [ { "key": {...}, "matched": 1 }, ... ] }
```

Each `key` object must contain *exactly* the table's primary key column(s) --
missing or extra columns are rejected with a 400 naming the problem, rather
than silently matching the wrong rows. All rows in one `updates`/`keys` array
are applied in a single transaction (all-or-nothing). `rows`/`updates`/`keys`
being missing, empty, or the wrong shape is also a clear 400, not a 500.
`insertedCount`/`rows`: `.returning('*')` (full inserted rows back) only
works on `pg`/`mssql` via knex -- `mysql2`/`sqlite3`/`better-sqlite3` return
`rows: null`, just the count.

**Per stored procedure** (where the dialect supports one -- see below), one
endpoint at `POST /api/<gateway>/proc/<name>`, with one declared `input`
param (`in: "body"`) per procedure parameter, matching its real signature --
so unlike table endpoints, procedure endpoints work normally in the endpoint editor's
"Try it" panel. The raw result is returned under a single `result` key.

**Stored procedure support by database client:**

| `client`          | Supported? |
|--------------------|------------|
| `pg`                | Yes (PostgreSQL `PROCEDURE`s via `CALL`; note that a `CALL` on Postgres doesn't return a row set the way a function does, so a procedure relying on `OUT`/`INOUT` parameters for its result may need to be wrapped in a function instead) |
| `mysql2`            | Yes (`CALL`) |
| `mssql`             | Yes (`EXEC`) |
| `sqlite3` / `better-sqlite3` | No -- SQLite has no stored-procedure concept; generation reports `proceduresSupported: false` and simply generates no procedure endpoints for these. |

A generated endpoint's backend config looks like this rather than a raw `query`
(see `src/types/config.ts`/`src/config/schema.ts` for the full shape) --
it's what the admin UI's endpoint editor shows as a read-only summary rather
than an editable SQL box, since regenerating (not hand-editing) is how you
pick up a schema change:

```yaml
backend:
  type: sql
  gateway: mainDb
  table: customers
  operation: list        # | bulkCreate | bulkUpdate | bulkDelete
  primaryKey: [id]
  columns: [id, first_name, last_name, status]   # list's filter whitelist
```

**Known limitations:** filters are exact-match only (no ranges, `OR`, or
`LIKE`); table/procedure names are only generated when they match
`[A-Za-z0-9_]+` (anything else is skipped and reported, rather than risking
a broken URL pattern); and the `pg`/`mysql2`/`mssql` introspection and
`CALL`/`EXEC` code paths are implemented against each driver's documented
`information_schema` behavior and knex's own named-binding support, but
weren't exercised against a live Postgres/MySQL/SQL Server server in this
project's development environment (only SQLite was available) -- they're
believed correct but worth a first real test against your own server.

## Adding a new endpoint

**Via the admin UI** (see below) -- endpoints and gateways created, edited,
or deleted there take effect immediately, no restart needed.

**By hand:**

1. Add a `.yaml` file anywhere under `config/endpoints/` (nested however deep
   you like, or flat -- the loader scans the whole tree) following the
   reference above. See "Folder layout mirrors each endpoint's path" above for
   the convention the admin UI itself follows, if you want to match it.
2. If it needs a new backend gateway, add it to `config/gateways.yaml`
   (and the corresponding secret to `.env`).
3. Restart the server (or click "Reload from disk" in the admin UI, or
   `POST /admin/api/reload`, to pick up hand-edited files without a restart).
4. `curl http://localhost:4000/__endpoints` to confirm it registered, then hit
   the endpoint.

Config files are validated on load (via `zod`); a malformed endpoint file is
logged and skipped rather than crashing the whole server, so one bad file
never takes down every other endpoint.

## Admin UI

A browser UI for creating endpoints, mapping input parameters, and configuring
output fields, served by the middleware itself at `/admin`. It talks to a
REST API (`/admin/api/*`) that persists straight to `config/endpoints/*.yaml`
and `config/gateways.yaml` -- the same files you could edit by hand --
and every change takes effect on the very next request, no restart required.

**Enabling it:** set `ADMIN_TOKEN` in `.env` to any random string (see the
generator command in `.env.example`). Leaving it unset disables `/admin/api/*`
entirely (it responds `503`) rather than running unauthenticated, since the
admin API can configure an endpoint that calls any URL or SQL query the
middleware's process can reach. Every request to it must carry
`Authorization: Bearer <ADMIN_TOKEN>`; the page itself prompts for the token
once and keeps it in the browser's local storage.

**Layout:** a left-hand sidebar lists every endpoint (grouped into a folder
tree) and every gateway (a plain row list), both visible at once -- there's
no tab to switch between them. Clicking either opens its full definition
into a detail panel on the right, where you edit, test, and save it in
place; "Close" clears the panel back to a placeholder, and "+ New" (above
each list) opens a blank one the same way. A sun/moon switch in the top bar
toggles between light and dark; left alone, the UI follows your OS's color
scheme automatically.

**What it does:**

- **Endpoints list** -- shows every endpoint as a collapsible folder tree grouped by
  path segment (matching how `config/endpoints/` is organized on disk -- see
  "Folder layout mirrors each endpoint's path" above), so endpoints under the same
  path prefix, or sharing a path but differing by method, sit together
  instead of one long flat list. Click a folder's header (or its chevron
  button) to collapse/expand it. Clicking an endpoint's own row opens it
  in the detail panel on the right; "+ New endpoint" opens a blank one the
  same way. The detail panel is organized into five tabs -- Basic, Backend,
  Parameters, Output, Test -- so only one section's fields are on screen at
  a time instead of one long stacked page: Basic covers id/method/path/
  description; Backend covers the gateway and its type-specific fields
  (pick a Gateway first -- Type is set from it automatically and greyed
  out, since the two can never disagree; Type only stays editable when
  Gateway is left as "(none)", for calling a URL directly); Parameters
  covers input parameters (name/in/type/required/
  default); Output covers the field mapping (target/source/transform/
  default), matching the YAML reference above field-for-field; Test is the
  "Try it" panel described below. Each tab shows a running count or summary
  (e.g. "Backend (json · crmJson)") so you can tell what's inside without
  switching to it, and opening any endpoint always starts back on the Basic
  tab. Saving keeps the endpoint open in the panel (now showing a "Delete"
  button) rather than closing it, so you can switch to Test and keep going
  right after.
- **Path auto-generation** -- "Auto-generate path from gateway + endpoint id"
  (on by default for a new endpoint) computes `Path` as
  `/<gateway-or-backend-type>/<endpoint id>` and keeps it in sync as you
  type the id or change the gateway; an "Extra path" field appends a
  fixed suffix, which is also where path params go (e.g. `/:id`). Turn the
  toggle off to type a fully custom path by hand instead. Reopening an
  existing endpoint re-detects auto mode (and splits the extra path back out)
  when its saved path still matches the pattern.
- **Input parameters** -- the "In" dropdown includes `env` alongside the
  request locations; picking it reveals an "Env var" field (defaults to the
  parameter's own name) and the "Try it" panel's value box for that
  parameter becomes an optional override on top of the real environment
  value.
- **Gateway common parameters** -- the gateway editor has a "Common
  parameters" section for name/value defaults every endpoint on that
  gateway can use as `{name}`; sensitive-looking names are masked the
  same way gateway fields are.
- **Test connection** (SQL/database gateways only) -- a "Test connection"
  button next to the gateway fields opens the database with the form's
  current settings, runs a trivial query, and reports success or the
  driver's actual error message, without saving the gateway first. When
  editing an existing gateway, a blank sensitive field (e.g. a password
  left as "unchanged") tests against its real stored value, the same way
  saving does.
- **Generate CRUD + procedure endpoints** (SQL/database gateways only, once
  saved) -- introspects the real database and generates list/bulk-create/
  bulk-update/bulk-delete endpoints for every table (skipping bulk-update/delete
  on a table with no primary key) plus one endpoint per stored procedure where
  the dialect supports it. Existing endpoints are never overwritten -- a
  conflict is skipped and reported, so it's safe to run again after a schema
  change. See "Auto-generated CRUD + stored-procedure endpoints" above for the
  exact request/response shapes. A generated table endpoint shows as a
  read-only summary in the endpoint editor (not an editable SQL box) since
  regenerating, not hand-editing, is how you pick up a schema change.
- **Try it panel** (inside the endpoint editor) -- fill in sample values for
  your input parameters and click "Fetch sample response" to call the real
  backend right now and see its raw response, then "Apply mapping to sample"
  to see what your current `output` config produces from it -- without
  saving the endpoint first, and without re-calling the backend on every
  mapping tweak. A generated table endpoint (list/bulk-create/bulk-update/
  bulk-delete) reads straight from the real request's query string or JSON
  body instead of declared input parameters, so the panel swaps in a
  "Query params" or "Request body" JSON box for it instead -- whichever that
  operation actually reads -- pre-filled with a placeholder showing the
  exact shape expected (e.g. `{"rows": [...]}` for bulk-create).
- **Gateways list** -- create/edit/delete named gateways. A field left
  blank on an existing gateway keeps its previously stored value (so
  editing one field of a SQL gateway doesn't require retyping the
  password); fields that look sensitive (password, token, secret, apiKey,
  etc.) are masked in the UI once saved.
- **Reload from disk** -- re-reads `config/endpoints/` and `gateways.yaml`
  from scratch, for when you'd rather hand-edit YAML and pick it up without
  restarting.
- **Workspace bar** -- a slim bar under the header shows which folder
  endpoints/gateways are currently loading from, plus their counts. Click
  "Change workspace…" to point this instance at a different folder -- see
  "Workspace" below.
- **Field info icons** -- every field in both editors has a small "i" icon
  next to its label. Click one to pop up a short explanation of what that
  field is for; click it again (or click elsewhere, or press Escape) to
  close it.
- **View gateway** -- once you've picked a Gateway on the Backend tab, a
  "View gateway" button next to it pops up that gateway's actual definition
  (kind, base URL/WSDL/connection details, common parameters) so you can
  check it without leaving the endpoint editor to go find it in the
  Gateways list.
- **Export** -- download an OpenAPI (Swagger) spec or a ready-to-run MCP
  server for this workspace. See "Exporting: OpenAPI spec + MCP server" below.

**Things worth knowing:**

- Once a gateway is entered or edited through the UI, `gateways.yaml`
  is rewritten in full on every save -- any hand-written comments in that
  file will be lost after the first UI edit. The same is true for an
  individual endpoint file the moment it's edited (not created) through the UI.
- A gateway field can hold either `${env.VAR_NAME}` (resolved from your
  `.env`/environment, recommended for secrets) or a literal value typed
  directly into the UI. A literal secret is written to `gateways.yaml` in
  plain text on disk -- prefer the `${env.X}` form for anything sensitive in
  a real deployment.
- Deleting a gateway that an endpoint still references is refused (409, with
  the list of dependent endpoint ids) rather than silently breaking that endpoint.

## Exporting: OpenAPI spec + MCP server

The admin UI's "Export" sidebar section (and `GET /admin/api/export/*` directly, if you'd rather script
it) gives you two ways to hand this workspace to another tool. Both reflect the *current* config the
moment you download them -- there's no separate "regenerate" step, so just download again after making
changes.

**OpenAPI spec (`Download OpenAPI spec (JSON)` / `GET /admin/api/export/openapi.json`)** -- a standard
OpenAPI 3.0.3 document describing every configured endpoint (as its real caller-facing path and method),
plus the built-in `/auth/login/{provider}`, `/auth/logout`, `/healthz`, and `/__endpoints` routes. Import
it into Postman, Swagger UI, an API client's codegen, or anything else that reads OpenAPI. An endpoint
whose gateway requires auth is marked with a bearer-token security requirement, naming which provider to
log in through first.

**MCP server (`Download MCP server` / `GET /admin/api/export/mcp-server`)** -- a single, dependency-free
JavaScript file (`naimix-mcp-server.js`) that turns this workspace into an MCP server any MCP-compatible
client (Claude Desktop, Claude Code, etc.) can use directly. It's a *thin proxy*, not a static snapshot:
every time it starts, it asks your live naimix instance what endpoints/gateways/auth providers currently
exist and builds its tools from that -- there's nothing to regenerate after a config change, just restart
the MCP client (or the script itself). It needs only Node.js 18+ (for the built-in `fetch`) and no
`npm install`.

To use it, save the downloaded file somewhere and add it to your MCP client's config, e.g. for Claude
Desktop/Code:

```json
{
  "mcpServers": {
    "naimix": {
      "command": "node",
      "args": ["/absolute/path/to/naimix-mcp-server.js"],
      "env": {
        "NAIMIX_BASE_URL": "http://localhost:3000",
        "NAIMIX_ADMIN_TOKEN": "your ADMIN_TOKEN value"
      }
    }
  }
}
```

`NAIMIX_ADMIN_TOKEN` is only ever used to *discover* the workspace's shape (the same admin API the
"Export" buttons themselves call) -- every actual tool call the server makes on your behalf goes through
the normal public routes, never back through `/admin/api/*`. Treat the downloaded file plus that token
together as a credential: whoever has both has full admin access to whatever `NAIMIX_BASE_URL` points at.

You'll get one `login_<provider>` tool per configured auth provider (taking `username`/`password`, except
an oauth2 `client_credentials` provider, which takes neither), a `logout` tool, a `list_endpoints` tool,
and one tool per configured endpoint. Log in with the right `login_*` tool before calling a tool for an
endpoint that requires it -- its description tells you which one.

**This only works against a `dev` build.** QA and Production instances don't expose `/admin/api/*` at all
(see "Deploying to QA/Production" below), so there's nothing for the MCP server to discover from there --
point `NAIMIX_BASE_URL` at a `dev` instance.

## Deploying to QA/Production

The admin console (UI + `/admin/api/*`) is a **development-only** tool. It
is not merely disabled by config in QA/Production -- it is a separate build
that never contains that code at all. See
[`DEPLOYMENT_ARCHITECTURE_NOTES.md`](DEPLOYMENT_ARCHITECTURE_NOTES.md)'s
"Installation: how development differs from QA/Production" for the full
reasoning; this section is the how-to.

**Three named targets, sharing one core:**

| | Entry point | `npm` scripts | Admin console |
|---|---|---|---|
| `dev` | `src/server/index.ts` | `npm run dev`, or `npm run build && npm start` | Present (gated by `ADMIN_TOKEN`) |
| `qa` | `src/server/qaIndex.ts` | `npm run dev:qa`, or `npm run build:qa && npm run start:qa` | Not present at all |
| `prod` | `src/server/prodIndex.ts` | `npm run dev:prod`, or `npm run build:prod && npm run start:prod` | Not present at all |

`qa` and `prod` run identical code today -- both are thin wrappers
(`qaIndex.ts`/`prodIndex.ts`) around the same `dataPlaneServer.ts` startup
logic and the same `dataPlaneApp.ts` Express app, differing only in their
startup log line ("QA data-plane" vs. "Production data-plane"). They're
kept as two separate entry files and build targets on purpose, so that if
QA and Production ever need to behave differently -- a feature flag, a
stricter default, anything -- that change has an obvious, low-friction
place to land (edit `qaIndex.ts` or `prodIndex.ts` alone) instead of
threading a new conditional through one shared target.

All three targets build on the same `src/server/coreApp.ts` (health/
introspection endpoints, caller-facing `/auth` login, and the dynamic
dispatcher that serves every configured endpoint) -- a business-logic fix
made there applies to all three automatically. Only the `dev` target
(`src/server/app.ts`) additionally imports `adminApi.ts`/`adminAuth.ts` and
mounts `/admin` + `/admin/api/*` on top; `src/server/dataPlaneApp.ts` (what
`qa` and `prod` both use) never imports either file, so the admin console
isn't reachable code in either of those processes, whatever `ADMIN_TOKEN`
is or isn't set to.

**Building for QA/Production:**

```bash
npm run build:qa    # -> dist-qa/server.js
npm run build:prod  # -> dist-prod/server.js
```

Each bundles its own entry point (via esbuild, first-party code only --
`node_modules` stays external, so it must still be installed alongside the
bundle at runtime) into its own single-file output, then runs
`scripts/checkDataPlaneBundle.js` against it: a structural check that greps
the bundled output for admin-only identifiers (`requireAdminAuth`,
`createAdminApiRouter`, and others) and fails the build if any turn up --
real proof this separation hasn't quietly regressed, not just a comment
asserting it holds. Run either with `npm run start:qa` / `npm run
start:prod`.

**Configuration** works the same way as the full app (`CONFIG_DIR` or the
legacy `ENDPOINTS_DIR`/`GATEWAYS_FILE`/`AUTH_PROVIDERS_FILE` trio -- see
"Environment variables" below), except there's no `SETTINGS_FILE`/"Change
workspace" support: that's the admin console's own feature for a developer
switching their local instance between Git checkouts, and doesn't apply to
a QA/Production instance reading a fixed shared volume. `ADMIN_TOKEN` isn't
read by either build at all -- there's no admin subsystem here for it to
gate.

## Workspace

Each person runs their **own instance** of this middleware on their **own
machine** -- there's no login system (for configuring the instance) and no
server shared between users. Where teams share things is their **Git repo of
`endpoints/` + `gateways.yaml` + `authProviders.yaml`**: everyone keeps their
own local checkout of it, points their own instance at that checkout's
folder (their **workspace**), and commits/pushes changes to Git themselves,
entirely outside this app (it never runs `git` for you).

A workspace is any folder containing (or that will contain) an `endpoints/`
subfolder, a `gateways.yaml` file, and an `authProviders.yaml` file --
exactly this project's own `config/` layout. Point an instance at one:

- **Admin UI** -- click "Change workspace…" in the bar under the header,
  enter the folder's path, and save. The folder must already exist (it's
  your Git checkout) but `endpoints/`/`gateways.yaml` inside it don't have
  to -- both are created automatically the first time you save an endpoint
  or gateway, same as `config/` was for this project's own demo data.
  Endpoints/gateways currently being served switch over immediately, no
  restart. The choice is remembered (written to `data/settings.json`,
  outside any workspace so it survives switching to a different one) and
  reused on the next `npm start`.
- **`CONFIG_DIR` env var** -- an alternative to the UI for a first run or
  scripted setup: set it to a folder path and it's used the same way (once
  the UI has saved a workspace, that takes priority over `CONFIG_DIR` on
  subsequent starts).
- **`ENDPOINTS_DIR` / `GATEWAYS_FILE` env vars** -- the original, lower-level
  way to point at endpoints and gateways independently rather than as one
  shared workspace; still supported, and what's used when neither the UI nor
  `CONFIG_DIR` has set one.

Switching workspaces doesn't touch Git in any way -- checking a new/updated
folder out, and committing/pushing your own changes back, are both things
you do yourself with your usual Git tooling before or after using this app.

**Keeping a checkout self-contained**: the "Change workspace…" UI always saves
an absolute path, since it's meant to point anywhere on disk -- but if you'd
rather your real `endpoints/`/`gateways.yaml` travel with the checkout
itself instead of living in a separate folder elsewhere, move them to
replace the project's own `config/` folder directly and set
`data/settings.json` to `{"configDir": "config"}` (a relative path, resolved
against wherever you run the app from). That way, renaming or moving the
whole checkout later never leaves a stale absolute path behind.

The shipped `config/` folder is a safe demo default -- every gateway in it
reads its connection details from `${env.*}` placeholders, never a literal
value, so it's fine to commit. If the real `gateways.yaml` you swap in has an
actual credential written into it instead, don't commit that: either move
the credential into an env var (recommended -- see [Environment
variables](#environment-variables) below) so `config/` stays commit-safe, or
add a local-only `/config/` line to your own `.gitignore` if it must keep a
literal secret.

No two people's instances share state (there's no shared database or
central server), so it's normal and expected for two teammates to have
different `endpoints/`/`gateways.yaml` open at once if they're mid-edit on
different Git branches -- resolving that is an ordinary Git merge, the same
as with any other files in the repo.

## Environment variables

See `.env.example`. The important ones:

| Variable            | Purpose                                             |
|----------------------|------------------------------------------------------|
| `PORT`               | Port the middleware listens on (default `4000`)     |
| `CONFIG_DIR`         | Folder containing both `endpoints/` and `gateways.yaml` (see "Workspace" above). Overridden by a workspace chosen through the admin UI, once one has been saved. |
| `ENDPOINTS_DIR`       | Directory of endpoint config files (default `config/endpoints`). Ignored once `CONFIG_DIR` or a UI-chosen workspace is in effect. |
| `GATEWAYS_FILE`      | Path to the gateways file (default `config/gateways.yaml`). Ignored once `CONFIG_DIR` or a UI-chosen workspace is in effect. |
| `AUTH_PROVIDERS_FILE` | Path to the auth providers file (default `config/authProviders.yaml`). Ignored once `CONFIG_DIR` or a UI-chosen workspace is in effect. See "Caller authentication" above. |
| `SETTINGS_FILE`      | Where the UI-chosen workspace is remembered (default `data/settings.json`) -- a per-machine preference file, not meant to be checked into Git. |
| `LOG_LEVEL`          | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`  |
| `ADMIN_TOKEN`        | `dev` target only (`npm run dev`/`npm start`) -- enables the admin UI/API at `/admin` when set; required bearer token for `/admin/api/*`. Unset = admin disabled. Not read at all by the `qa`/`prod` targets (`npm run start:qa`/`start:prod`); see "Deploying to QA/Production" above. |
| `MAX_REQUEST_BODY_SIZE` | Max JSON/urlencoded request body size (default `10mb`; e.g. `500kb`, `1gb`). Raise this if a real payload trips "request entity too large". |

Everything else in `.env.example` (`DEMO_*`) only feeds the bundled demo
config; replace those with your real backends' variables.

## Project structure

```
src/
  config/       # zod schemas, YAML/JSON loader, ${env.X} substitution
  connectors/   # json / xml / soap / sql backend connectors + {param} substitution
  transform/    # JSONPath-based declarative output mapper
  auth/         # AuthProvider abstraction (basicLogin/oauth2), session store, AuthService -- see AUTH_DESIGN_NOTES.md
  server/
    endpointRegistry.ts        # in-memory endpoint table + file persistence (hot-swappable, folder repointable)
    gatewaysRegistry.ts  # in-memory gateways table + file persistence (same)
    authProvidersRegistry.ts   # in-memory auth-providers table + file persistence (same)
    workspaceSettings.ts    # "which workspace is this instance pointed at" -- see Workspace
    dispatch.ts              # one dynamic handler that serves every configured endpoint (enforces requiresAuth)
    authRoutes.ts            # POST /auth/login/{provider}, POST /auth/logout
    adminApi.ts, adminAuth.ts  # /admin/api/* REST API + bearer-token auth -- development build ONLY, see below
    secretRedaction.ts       # shared "mask secrets, blank-means-unchanged" helpers (gateways + auth providers)
    coreApp.ts               # shared by all three targets below: cors/body-parsing, healthz/__endpoints, /auth, the dispatcher
    app.ts, index.ts         # FULL app (admin + data plane) -- the `dev` target, see "Deploying to QA/Production"
    dataPlaneApp.ts, dataPlaneServer.ts  # DATA-PLANE-ONLY app + shared startup logic -- never imports adminApi.ts/adminAuth.ts
    qaIndex.ts, prodIndex.ts  # thin `qa`/`prod` entry points, both calling dataPlaneServer.ts -- kept separate so they can diverge later
    paramExtractor.ts, errors.ts, logger.ts
  mock-backend/ # standalone demo backend (JSON+XML+SOAP+SQLite) used by dev & tests
  types/        # shared TypeScript types
public/admin/   # the admin UI (static HTML/CSS/JS, no build step) -- development build only
scripts/
  checkDataPlaneBundle.js  # fails `npm run build:qa`/`build:prod` if admin code leaks into either bundle
config/
  endpoints/*.yaml       # one file per endpoint
  gateways.yaml    # named backend gateways
  authProviders.yaml  # named auth providers -- see "Caller authentication"
test/           # vitest + supertest test suite
```

## Introspection & operations

- `GET /healthz` -- status plus how many endpoints loaded successfully.
- `GET /__endpoints` -- lists every currently registered endpoint (id, method,
  path, description, backend type). Useful for confirming config changes
  took effect without reading the YAML.
- Errors are normalized: a `ValidationError` (bad/missing input) returns
  `400`; a backend HTTP error is passed through with its original status
  code where available, otherwise `502`; anything unexpected is `500`. All
  responses are `{ error, message, backendBody? }`.

## Known limitations / natural next steps

- Output mapping is field-by-field (JSONPath in, dot-path out, optional
  transform); there's no support yet for computed/concatenated fields
  (e.g. `fullName = firstName + " " + lastName"`) or conditionals. A
  JSONata/JMESPath expression mode would be the natural extension if you
  need that.
- Caller authentication (see "Caller authentication" above) currently covers
  a bespoke login API, an OAuth2 password/client_credentials grant, and
  LDAP/Active Directory plain simple bind -- a gateway with no `requiresAuth`
  is still unauthenticated, same as before. SAML and the OAuth Authorization
  Code (browser redirect) flow are designed but not implemented -- see
  `AUTH_DESIGN_NOTES.md`. The `ldap` provider is plain simple-bind only
  (no Kerberos/SPNEGO SSO, which `AUTH_DESIGN_NOTES.md` defers to a later
  phase); a free, self-hosted local LDAP test directory (seeded users/
  groups, no external dependency) is available to develop and try it
  against -- see `docker/openldap/README.md` (`npm run test-ldap`), or the
  in-process fake LDAP server the automated test suite uses
  (`src/mock-backend/ldapServer.ts`), seeded identically. Sessions live in
  one process's memory, so this doesn't yet work behind a load-balanced
  multi-instance deployment -- see `AUTH_DESIGN_NOTES.md`'s "Multi-instance /
  load balancing" and `DEPLOYMENT_ARCHITECTURE_NOTES.md`.
- The SOAP connector caches one client per WSDL URL and calls
  `client.setEndpoint()` per request; if you truly need multiple concurrent
  endpoints behind the *same* WSDL URL, split them into separate WSDL
  URLs/gateways.
- The admin API's single `ADMIN_TOKEN` is one shared secret, not per-user
  accounts/roles -- fine for a small team or personal use; a real
  multi-user deployment would want proper auth in front of `/admin`.
- Generated CRUD endpoints' `list` filters are exact-match only (no ranges,
  `OR`, or `LIKE`), and bulk update/delete target rows strictly by primary
  key (see "Auto-generated CRUD + stored-procedure endpoints"). The
  `pg`/`mysql2`/`mssql` introspection and procedure-call code paths weren't
  exercised against a live server of those kinds in this project's
  development environment (only SQLite was available) -- worth a first real
  test against your own server.
