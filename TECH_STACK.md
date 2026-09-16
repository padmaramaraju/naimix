# Naimix — Technology Choices

This document explains **why** each major package/framework in this project was picked, what the
realistic alternatives were, and what was traded off. It's a companion to `TECHNICAL.md` (which
explains how the chosen stack is actually used) and `README.md` (which explains how to operate it) —
this one exists purely to answer "why this library and not that one."

Like `TECHNICAL.md`, this is a living document: when a dependency is added, replaced, or upgraded for
a real reason (not just a routine patch bump), a section here is added or updated, and a note is added
to `TECHNICAL.md`'s changelog pointing back here.

## Quick reference

| Area | Chosen | Version pinned | Considered instead |
|---|---|---|---|
| Language / runtime | TypeScript on Node.js | Node `>=24.0.0` | Plain JS on Node; Deno; Bun |
| Web framework | Express | `^4.21.2` | Fastify, Koa, Hapi, NestJS, Hono |
| Schema validation | Zod | `^3.24.1` | Joi, Yup, ajv, io-ts, TypeBox |
| SQL query builder | Knex | `^3.1.0` | Prisma, TypeORM, Sequelize, Drizzle, Kysely, raw drivers |
| SQL drivers | `pg`, `mysql2`, `mssql`, `sqlite3`, `better-sqlite3` | see `package.json` | per-dialect alternatives, below |
| HTTP client (JSON/XML backends) | Axios | `^1.7.9` | native `fetch`/`undici`, `node-fetch`, `got` |
| XML parsing | fast-xml-parser | `^5.11.0` | `xml2js`, `libxmljs2`, `sax` |
| SOAP client | `soap` | `^1.10.0` | `strong-soap`, hand-rolled XML+HTTP |
| YAML parsing | `js-yaml` | `^4.1.0` | `yaml` (eemeli/yaml) |
| JSONPath (output mapping) | `jsonpath-plus` | `^10.2.0` | `jsonpath`, `jmespath`, hand-written path walker |
| Endpoint path matching | `path-to-regexp` (explicit v8) | `^8.4.2` | Express's own bundled (older) version, `regexparam` |
| Logging | `pino` + `pino-pretty` | `^9.6.0` / `^13.0.0` | `winston`, `bunyan`, `console` |
| Test runner | `vitest` + `supertest` | `^4.1.11` / `^7.2.2` | `jest` + `supertest`, `mocha`+`chai`, `node:test` |
| Dev-mode execution | `tsx` | `^4.23.12` | `ts-node`, `nodemon` + `tsc --watch` |
| Admin UI frontend | Plain HTML/CSS/JS, no framework, no build step | — | React/Vue + Vite, a server-rendered template engine |
| Config storage | YAML/JSON files on disk | — | A database table, a config-as-code TS/JS module |

The sections below go through the reasoning for each row.

## Language & runtime: TypeScript on Node.js

**Alternatives considered:** plain JavaScript (no type layer); Deno; Bun.

TypeScript was the clear choice for a project whose entire value proposition is *config validated
against a schema* — the endpoint/gateway config shapes (`src/types/config.ts`) and the Zod schemas
that validate them (`src/config/schema.ts`) are meant to stay in lockstep, and a type layer is what
catches the two drifting apart at compile time rather than at runtime in production. Plain JavaScript
would have made every one of the schema/type "mirror" relationships described throughout
`TECHNICAL.md` a matter of manual discipline instead of a compiler check.

Node.js (over Deno or Bun) was chosen for ecosystem maturity and operational familiarity: every
dependency this project needs (`knex`, `soap`, `fast-xml-parser`, five separate SQL drivers) is an npm
package with the longest, most battle-tested history on Node specifically. Deno and Bun both have
improving Node compatibility layers, but for a project whose core risk surface is *database driver
correctness across five dialects* (see the SQL connector), betting on the runtime with the longest
track record for exactly those drivers was the safer call over the faster startup times or built-in
tooling Deno/Bun offer. Node 24 (Active LTS) specifically was chosen over Node 20/22 when this was
revisited mid-project — see `TECHNICAL.md`'s changelog entry for that decision; it was a runtime
*version* choice, not a runtime *engine* choice.

## Web framework: Express

**Alternatives considered:** Fastify, Koa, Hapi, NestJS, Hono.

This project's HTTP layer is unusually simple by framework standards: there's exactly one real
runtime dispatcher (`src/server/dispatch.ts`'s single catch-all middleware, matching against an
in-memory endpoint table) plus one admin CRUD API. It doesn't need a framework's routing engine to do
much work at all — Express's router is barely used outside `express.static` for the admin UI and the
`Router()` instance in `adminApi.ts`. That changes what actually matters in the comparison:

- **Fastify** would be the throughput-oriented choice — it's measurably faster than Express for raw
  JSON request handling (roughly 2-3x in typical benchmarks) and has first-class TypeScript support
  and schema-based validation built in. It was a real contender, but this project already does its
  schema validation with Zod (chosen independently — see below) rather than Fastify's own
  JSON-Schema-based validation, so Fastify's main built-in advantage over Express doesn't actually get
  used here. Express's simpler, less opinionated middleware model was a better fit for a project whose
  own dynamic dispatcher *is* the interesting part.
- **Koa** (from the same original author as Express) has a cleaner async middleware model, but a much
  smaller ecosystem and requires more assembly of your own pieces (routing, body parsing) that Express
  ships with sensible built-ins for (`express.json()`, `express.static()`).
- **Hapi** is configuration-heavy and enterprise-oriented in a way that adds ceremony this project's
  actual routing needs don't call for.
- **NestJS** is a full application framework (DI container, decorators, module system) built for
  large, structured server applications with many discrete controllers/services. This project has
  exactly one real dynamic endpoint handler by design — a framework built around registering many
  individual typed controllers would be fighting the architecture rather than serving it.
- **Hono** is the newest and most interesting alternative: TypeScript-first, extremely fast, and
  designed for edge/serverless runtimes (Cloudflare Workers, Vercel Edge). It's a poor fit here
  specifically because this project is not edge-deployed — it's a long-running process holding
  persistent SQL connection pools and cached SOAP clients, which is exactly the stateful, long-lived
  server model Hono is *not* optimized for.

**Bottom line:** Express's massive middleware ecosystem, Node-native `req`/`res` model (which every
connector's error-handling relies on via `err.statusCode`), and the fact that none of the other
frameworks' headline advantages (raw throughput, edge deployment, built-in schema validation) apply to
this project's actual bottleneck (backend call latency, not framework routing overhead) made it the
pragmatic choice. This is the one area where a future performance requirement (very high request
volume) would be the concrete trigger to revisit Fastify specifically.

## Schema validation: Zod

**Alternatives considered:** Joi, Yup, ajv (JSON Schema), io-ts, TypeBox.

Zod does double duty in this project: it validates every config file and admin API request body *and*
its inferred types (`z.infer<typeof endpointConfigSchema>`) are the actual TypeScript types used
throughout the codebase (`EndpointConfigParsed`, `GatewaysFileParsed`) — there's no separate
hand-maintained type layer to keep in sync with the validation layer for the schemas defined with
`z.infer`. That specific "schema *is* the type" property is Zod's signature advantage over the
alternatives:

- **Joi** and **Yup** are both mature, widely used validators, but neither is TypeScript-native in the
  same way — types have to be hand-declared and kept in sync separately, or derived through a much
  clunkier inference story. Given how central the endpoint/gateway schema is to this whole project
  (`schema.ts` is described in `TECHNICAL.md` as "the real API surface of the project"), a validator
  whose inferred types are first-class was worth prioritizing over Joi's larger legacy ecosystem or
  Yup's simpler API.
- **ajv** (JSON Schema-based) is the fastest of the group and what Fastify uses internally, but working
  in JSON Schema directly is verbose for the kind of nested discriminated unions this project's
  `backendSchema` needs (four backend types sharing a discriminant, each with its own field
  refinements) — Zod's `z.discriminatedUnion` plus `.superRefine()` for cross-field rules (like the SQL
  backend's "exactly one of query/table+operation/procedure" constraint) reads far more directly than
  the equivalent JSON Schema `oneOf`/`if`/`then` composition would.
- **io-ts** has a similar "schema is the type" philosophy to Zod but a much steeper, more
  functional-programming-flavored API (`Either`/`fp-ts` idioms) that would have added real onboarding
  friction for a project meant to be extended by whoever's maintaining it, not just its original
  author.
- **TypeBox** is close to Zod in ergonomics and produces JSON Schema output (useful if this project
  ever needed to publish an OpenAPI spec derived from its schemas), but has a smaller community and
  fewer real-world examples of the kind of custom cross-field refinement this schema leans on.

**A live, honest caveat:** Zod 4 has since shipped as a stable major version, with meaningfully faster
parsing and much better TypeScript compilation performance than v3 ([zod.dev/v4](https://zod.dev/v4)).
This project is still pinned to `^3.24.1`. That's a deliberate "not yet, not without a reason" choice
rather than an oversight — v4 has breaking API changes, and there's been no concrete pain point
(compile time, validation throughput) in this project that the migration would actually fix yet. It's
listed here as a real, tracked option for a future revisit, not a rejected one.

## SQL query builder: Knex

**Alternatives considered:** Prisma, TypeORM, Sequelize, Drizzle, Kysely, or just the raw driver
packages directly (no query builder at all).

This is the decision most specific to this project's actual requirements, and the one with the least
ambiguity in hindsight. The defining constraint: **the same endpoint config shape, and the same
generated-CRUD feature, has to work identically whether the underlying database is Postgres, MySQL,
SQL Server, or SQLite — chosen per-gateway, at runtime, from user-supplied config** (see
`TECHNICAL.md`'s [SQL connector](TECHNICAL.md#sql-connector) section). That rules out most of the
modern TypeScript ORM landscape outright:

- **Prisma** requires its own schema file and a generated client *per data model, compiled ahead of
  time* — it's not designed for "connect to whatever database a user's gateway config names, with
  whatever tables happen to exist there, and introspect them at runtime," which is exactly what this
  project's CRUD-generation feature does. Prisma's schema-first workflow is excellent for a project that
  owns and evolves its own database schema; this project is a middleware that has *no* schema of its
  own — it borrows and adapts to schemas someone else owns.
- **Drizzle** (and **Kysely**) are the strongest modern contenders — both are meaningfully more
  type-safe than Knex when a project's tables are known at compile time (you define a TypeScript
  schema and get fully typed query results back). But that type-safety model assumes the same
  "known-at-compile-time schema" shape Prisma does, just with less codegen ceremony. This project's
  entire SQL introspection module (`sqlIntrospect.ts`) exists specifically because the tables aren't
  known until a real gateway is inspected at runtime — there's no TypeScript schema to write for a
  table this project has never seen before. Drizzle/Kysely's compile-time type safety, the whole reason
  to reach for them over Knex, isn't something this project's actual use case (dynamic, per-gateway,
  runtime-discovered tables) can benefit from.
- **TypeORM** and **Sequelize** are both entity/decorator-based ORMs oriented around a project's own
  persistent domain models (`@Entity()` classes mapped to tables the application owns) — the same
  schema-ownership mismatch as Prisma, plus a heavier abstraction (lazy-loading, unit-of-work patterns)
  that this project's simple "run this query, get plain rows back" needs don't call for.
- **Raw driver packages directly** (`pg`, `mysql2`, etc., with no query builder) were the other real
  option, and would have meant hand-writing five near-identical implementations of every generated CRUD
  operation (list/bulkCreate/bulkUpdate/bulkDelete) and every introspection query, one per dialect,
  with each dialect's own placeholder syntax (`$1` for pg, `?` for mysql2, `@p1` for mssql). Knex's
  query builder produces the right SQL text and placeholder style for whichever `client` a gateway
  names from one shared code path — this is the single biggest reason `sql.ts` and `sqlIntrospect.ts`
  are each one file instead of five.

Knex is also comparatively unglamorous — it's the oldest, least actively-hyped option in this list, and
recent comparison writeups (2026) generally frame it as the "stable, mature, less type-safe" choice
against Drizzle's "modern, type-safe" positioning. For *this* project specifically, "mature and
dialect-flexible" beat "modern and type-safe at compile time," because the compile-time safety the
newer tools offer doesn't apply to a schema this project only discovers at runtime.

### SQL drivers: `pg`, `mysql2`, `mssql`, `sqlite3`, `better-sqlite3`

These aren't really "chosen over alternatives" so much as "the drivers knex itself documents and
supports per dialect" — but within that, a couple of specific calls were made:

- **`mysql2` over `mysql`** — `mysql2` is the actively maintained, faster, Promise-native successor;
  the original `mysql` package is effectively legacy at this point and knex's own docs point to `mysql2`.
- **`better-sqlite3` (as the demo/default) alongside `sqlite3` (for schema-enum completeness)** —
  `better-sqlite3` is synchronous and meaningfully faster for the local demo/dev/test use case this
  project actually exercises SQLite for, while `sqlite3` (the original async, node-gyp-based driver)
  is kept as a selectable `client` option too since some existing user setups may already depend on its
  specific async driver semantics. `sqlite3` was pinned to `^6.0.1` specifically (not the `^5.x` range)
  after `^5.x` was found to pull in an old `node-gyp`/`tar` dependency chain with known vulnerabilities
  — see `TECHNICAL.md`'s changelog.
- **`mssql`** is the standard, and effectively only serious, actively-maintained SQL Server driver for
  Node — there wasn't a real alternative to weigh here.

## HTTP client (JSON/XML backends): Axios

**Alternatives considered:** native `fetch`/`undici`, `node-fetch`, `got`.

Node has had a built-in `fetch` (backed by `undici`) since Node 18, which removes the historical reason
to reach for Axios at all (no native HTTP client with promises). Axios was still chosen here for two
concrete, project-specific reasons rather than habit:

- **`validateStatus: () => true`** — every backend call in this project (`json.ts`, `xml.ts`) needs to
  inspect a 4xx/5xx response body *before* deciding how to report the error (the connector attaches
  `backendBody` to its own thrown error so the caller sees what the real backend actually said). Native
  `fetch` doesn't reject on a non-2xx status at all (you always get a `Response`, checking `.ok`
  yourself), which is *closer* to what's needed, but Axios's explicit `validateStatus` hook plus its
  automatic JSON body parsing (`response.data`) and unified error shape across both JSON and XML
  (`responseType: "text"`) calls meant less connector-level boilerplate for the same behavior.
- **Timeout handling** — Axios's `timeout` option is a single config field; achieving the same with
  native `fetch` requires wiring up an `AbortController` and a `setTimeout` by hand at every call site
  (or a small wrapper utility, which is effectively re-implementing the part of Axios being avoided).

`got` is a strong, actively maintained alternative with a similar feature set to Axios, but has less
universal name recognition and no real functional advantage for this project's specific needs over
Axios, which was already the more familiar default. This is one of the more "reasonable default, not
a hard requirement" choices in this document — native `fetch`/`undici` would work fine here too with a
thin wrapper, and is worth a second look if a future goal is trimming dependencies.

## XML parsing: fast-xml-parser

**Alternatives considered:** `xml2js`, `libxmljs2`, `sax`.

`fast-xml-parser` was chosen for being dependency-free (no native bindings to compile, unlike
`libxmljs2`, which wraps `libxml2` as a C++ addon — a real concern for a project already juggling five
separate native SQL driver packages), actively maintained, and fast enough that XML parsing has never
shown up as a bottleneck anywhere in this project. Its behavior of turning repeated sibling tags into a
JS array automatically (documented in `TECHNICAL.md`'s XML connector section, along with the
single-item-vs-array caveat that behavior implies) is exactly the shape the output mapper's
`output.root` JSONPath selection is built to consume.

`xml2js` is the older, more traditional choice and still very widely used, but is meaningfully slower
and has a more callback-oriented (though promise-wrapped) API than `fast-xml-parser`'s direct
synchronous `parse()` call. `sax` is a streaming/event-based parser — a reasonable choice for very
large XML documents processed incrementally, but this project's XML responses are the kind of
small, complete API payloads that don't benefit from streaming, and a streaming parser would have made
the "turn this into one plain JS object for the mapper" use case more code, not less.

## SOAP client: `soap`

**Alternatives considered:** `strong-soap`, hand-rolled WSDL parsing + raw XML/HTTP.

`soap` (the `node-soap` project) is the long-standing, most widely used SOAP client for Node — still
seeing real traffic (roughly 470K weekly npm downloads as of this writing) and active maintainer
support. Its WSDL-driven approach — generating an `<operationName>Async` method per operation directly
from a fetched/parsed WSDL — is exactly the shape `soap.ts`'s connector needs: the endpoint config just
names an `operation`, and the client (cached per resolved WSDL URL — see `TECHNICAL.md`) does the work
of turning that into the right SOAP envelope.

`strong-soap` is a from-scratch rewrite of `node-soap` (maintained under the LoopBack org) aimed at
fixing some of `node-soap`'s rough edges around complex WSDLs and namespaces — a legitimate alternative
worth trying specifically if a future real-world WSDL proves hard for `soap` to parse correctly, but
there was no concrete problem driving that switch when this project was built, and `soap`'s larger
install base made it the safer default for a project whose actual SOAP integration surface (one
operation, one demo WSDL) hasn't yet stress-tested either library's WSDL-parsing edge cases.
Hand-rolling SOAP envelope construction directly over Axios/XML (skipping a SOAP library entirely) was
rejected outright — WSDL parsing, envelope construction, and fault handling are exactly the kind of
fiddly, spec-heavy work not worth re-implementing when a maintained library already does it.

## YAML parsing: `js-yaml`

**Alternatives considered:** `yaml` (the `eemeli/yaml` package).

Both are solid, actively maintained choices for this project's needs (parsing endpoint/gateway config
files, and round-tripping them back to disk on an admin API save via `yaml.dump()`). `js-yaml` was
picked mainly for being the longer-established, more widely depended-upon of the two, with a simpler
single-function `load()`/`dump()` API that matches exactly how this project uses it (whole-document
parse and whole-document serialize — no need for the `yaml` package's more granular
document/AST-editing API, which is its main advantage when a use case needs to preserve comments and
formatting through an edit). Since this project always regenerates an endpoint/gateway file wholesale
from its in-memory config object on save (rather than patching a specific line), that finer-grained
editing capability wouldn't have been used anyway.

## JSONPath (output mapping): `jsonpath-plus`

**Alternatives considered:** `jsonpath` (the original), `jmespath`, a hand-written path-walking
function.

The entire output-mapping engine (`transform/mapper.ts`) is built on JSONPath expressions for both
`output.root` (selecting a collection) and each field's `source` — this is genuinely the right tool for
that job, since JSONPath's `$.a.b[*].c`-style syntax is exactly what an endpoint author needs to describe
"pull this value out of an arbitrarily-shaped backend response," and it's a syntax most developers
integrating with REST/XML APIs already have some familiarity with. `jsonpath-plus` specifically (over
the original `jsonpath` package) was chosen for being the more actively maintained fork with a larger
supported syntax surface and better handling of edge cases (this project relies on its `wrap: true`
option to always get an array of matches back, simplifying `extractSource()`'s "take the first match,
or fall through to the field's default" logic into one straightforward check).

`jmespath` is a different, arguably more powerful query language (used by the AWS CLI, among others)
with built-in support for transformations/filtering beyond plain path selection — but that expressive
power isn't needed here, since this project's own `transform` field (`toString`/`toNumber`/etc.)
already covers the small set of per-field transforms an endpoint author needs, applied *after* JSONPath
extraction rather than as part of the query language itself. Introducing a second, more powerful query
language on top of a schema that already has a `transform` field would have been redundant complexity.

## Endpoint path matching: `path-to-regexp` (explicit v8 dependency)

**Alternatives considered:** relying on Express's own older bundled version; `regexparam`.

This one is really an internal-consistency decision rather than a competitive one: Express 4 bundles
its own (older, 0.1.x-era) version of `path-to-regexp` internally, but this project's dynamic
dispatcher (`EndpointRegistry`/`dispatch.ts`) needs to compile and match `:param`-style path patterns
*outside* of Express's own router entirely (since endpoints are matched against an in-memory table, not
registered as individual Express handlers). Depending on Express's internal bundled copy would have
been both fragile (an implementation detail Express doesn't guarantee as a stable public API) and stuck
on an old API shape. Taking `path-to-regexp@8` as an explicit direct dependency gets the current,
actively maintained version with its current (differently-shaped) API, decoupled from whatever version
Express happens to bundle internally. `regexparam` is a smaller, faster alternative with a more limited
feature set (no named capture groups exposed the same way) — not worth the trade-off for the very
small amount of matching work this project actually does per request.

## Logging: `pino` + `pino-pretty`

**Alternatives considered:** `winston`, `bunyan`, plain `console.log`.

`pino` is the fastest structured JSON logger in the Node ecosystem, and — more relevant to this
project's own design than raw speed — its `.child({ ... })` API (used throughout `dispatch.ts` and
`adminApi.ts` to attach an `endpointId` or `component` label to every log line for a given request/module)
maps directly onto how this project wants to scope its logging. `pino-pretty` is used purely as a dev
convenience transport (colorized, human-readable output when `NODE_ENV !== "production"`), while
production gets pino's default fast structured JSON output straight to stdout, ready for any log
aggregator.

`winston` is the more configurable, more historically dominant option, with a richer built-in
transport ecosystem (multiple simultaneous outputs, custom formats) — but that configurability comes
with materially worse raw throughput than pino, which matters more for a middleware that logs at least
once per proxied request than for most application types. `bunyan` pioneered the structured-JSON
approach pino builds on but is far less actively maintained today. Plain `console.log` was never a
real option once "the admin API and every backend call need contextual, filterable log lines" was a
requirement — that needs structure (level, scoped fields) `console.log` doesn't provide on its own.

## Testing: `vitest` + `supertest`

**Alternatives considered:** `jest` + `supertest`, `mocha` + `chai`, Node's built-in `node:test`.

`vitest` was picked for being noticeably faster than Jest (native ESM/TypeScript support without a
separate transform step, and a much faster watch mode) while keeping a nearly identical
`describe`/`it`/`expect` API — meaning the choice cost nothing in familiarity. `supertest` (used
alongside either test runner identically) is the standard way to assert against an Express `app`
instance directly, in-process, without actually binding a real listening socket for every test — which
is what makes it possible for `test/middleware.test.ts` to spin up one real `app` plus one real mock
backend for the whole file's ~50 tests rather than one server per test.

`jest` remains an extremely reasonable, arguably safer-by-popularity choice — it just doesn't have a
concrete advantage over vitest for this project's needs, and vitest's speed is a genuine, felt
day-to-day benefit given the size the test suite has already grown to (59 tests as of this writing).
`mocha`+`chai` is more modular (pick your own assertion library, runner, mocking library separately)
but that modularity is exactly what wasn't wanted — an all-in-one runner with built-in assertions and
mocking meant less test-infrastructure code to write and maintain. Node's own built-in `node:test`
runner has matured a great deal and would remove a dependency entirely, but lacks vitest's watch-mode
ergonomics and some assertion conveniences (`toMatchObject`, snapshot testing) this project's tests
lean on lightly today — worth a second look if dependency count ever becomes a real concern.

## Dev-mode execution: `tsx`

**Alternatives considered:** `ts-node`, `nodemon` + `tsc --watch` in two terminals.

`tsx` runs TypeScript directly (via esbuild under the hood) with a built-in `--watch` flag, which is
what powers this project's `npm run dev`/`npm run mock-backend` scripts — one command, fast restarts,
no separate compile step to remember to run. `ts-node` is the older, more established option but is
noticeably slower (especially in its type-checking mode) and needs `nodemon` bolted on separately for
watch-mode restarts, i.e. two tools doing what `tsx` does with one. Running `tsc --watch` in one
terminal and `nodemon dist/...` in another works, but is strictly more manual setup for the same
end result. `tsx` is dev/build tooling only — it has no bearing on the production `npm run build`/
`npm start` path, which compiles with plain `tsc` and runs the compiled JS directly.

## Admin UI frontend: plain HTML/CSS/JS, no framework, no build step

**Alternatives considered:** React or Vue with a bundler (Vite, webpack); a server-rendered template
engine (EJS, Handlebars) instead of a client-rendered SPA-lite.

The admin UI (`public/admin/`) is genuinely simple by SPA standards — a two-list sidebar, an inline
detail panel that doubles as both editors, a handful of repeatable list editors, a light/dark toggle —
and is served directly via `express.static` with zero build step:
edit `admin.js`, refresh the browser, done. A framework like React would bring real, felt benefits at a
larger UI surface (component reuse, declarative state-to-DOM binding instead of `admin.js`'s manual
`el()`/`innerHTML` DOM manipulation) — but it would also mean introducing a build pipeline (Vite or
webpack, a `dist/admin` output directory, a decision about whether that build step runs at `npm run
build` time or needs its own separate step) for a UI that, as of this writing, is one ~1,150-line
JavaScript file. That trade-off wasn't worth it yet. A server-rendered template engine was also
considered and rejected: this UI needs real client-side interactivity (live path auto-generation,
tabbed/collapsible sections, a "Try it" panel that calls the API and re-renders results without a page
reload) that a template engine doesn't help with — it would only have helped with the *initial* HTML shape,
which is the smallest part of what this UI actually does.

**This is the item in this document most likely to need revisiting as the admin UI grows.** If
`admin.js` roughly doubles in size, or state management (which sections are open, which endpoint is being
edited, keeping the endpoints list in sync after a save) gets meaningfully harder to reason about by hand,
that's the concrete signal to introduce a framework — not a fixed size threshold, but a felt one.

## Config storage: YAML/JSON files on disk

**Alternatives considered:** storing endpoint/gateway config in a database table; a
config-as-code TypeScript/JS module.

Config-as-files was less a "compared against alternatives" decision and more the natural consequence of
two other decisions already made: config needs to be **hand-editable** (a developer should be able to
open `config/endpoints/some-endpoint.yaml` in an editor, understand it, and change it directly — one of this
project's stated goals from the start) and **hot-reloadable without a restart** (see
`TECHNICAL.md`'s [Hot-reloadable registries](TECHNICAL.md#hot-reloadable-registries)). A database table
would satisfy the second requirement but actively work against the first (no diffable, git-trackable,
directly-editable representation, and a whole extra piece of infrastructure — a database — just to
store the *description* of how to talk to other backends, one of which might itself be a database). A
config-as-code JS/TS module (`export const endpoints = [...]`) would be diffable and hand-editable, but
loses hot-reload-without-restart entirely (changing a JS module's exported value requires re-importing
it, which Node doesn't support cleanly at runtime the way re-reading a YAML file does) and loses the
admin UI's ability to safely write back a single endpoint's file without touching any other endpoint — a
concern this project cares about enough to have built the whole
[folder-layout](TECHNICAL.md#folder-layout-mirrors-each-endpoints-path) feature around keeping each
endpoint's file independent and easy to locate.

## General principles used across these choices

A few patterns recur across the reasoning above, worth stating explicitly since they'll apply to any
future dependency decision on this project too:

1. **Prefer the option whose main advantage this project can actually use.** Fastify's speed and
   Drizzle's compile-time type safety are both real, well-documented advantages of those tools — and
   both were set aside because this project's actual constraints (a config-driven dynamic dispatcher
   instead of many typed endpoints; runtime-discovered database schemas instead of compile-time-known
   ones) mean neither advantage would actually be realized here.
2. **Prefer fewer native/compiled dependencies where a pure-JS option is equally capable.**
   `fast-xml-parser` over `libxmljs2`, `better-sqlite3`'s synchronous C++ binding accepted only because
   there's no pure-JS SQLite driver worth using instead.
3. **Prefer the tool with the larger, longer-lived install base when the newer alternative's benefit
   doesn't clearly apply to this project** (Knex over Drizzle/Kysely; `soap` over `strong-soap`) —
   but treat that as a *default*, not a rule, and say so explicitly when a specific real problem would
   be the trigger to reconsider (noted per-section above).
4. **Don't add a dependency for a capability the project doesn't need yet.** `jmespath`'s
   transformation power, React's component model, a database-backed config store — each was rejected
   specifically because the extra capability isn't something this project's current requirements call
   for, not because the tool itself is bad.
