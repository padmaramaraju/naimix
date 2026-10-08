# Ops Console (QA/Production Runtime Observability) — Design Notes

**Status: brainstorm only — nothing described here has been implemented.** Captured for reference before any of this gets built, same as `AUTH_DESIGN_NOTES.md` and `DEPLOYMENT_ARCHITECTURE_NOTES.md` were before their respective features existed.

## The problem

QA and Production currently have no operational visibility of their own. `dataPlaneServer.ts` logs a startup line and then runs silently -- there's no way to see current CPU/memory, which endpoints are slow or erroring, tail logs, or inspect what a request/response actually looked like, short of SSHing into the box or depending entirely on whatever external log shipping ops has set up outside this app. Add a protected, token-gated surface that offers: environment variable visibility, system monitoring (CPU/memory), per-endpoint throughput/latency and error counts, real-time log access with export, and full request/response capture (including the backend call) -- with room to add more panels later without restructuring.

## Not the Developer Console -- a deliberately separate thing

This is easy to conflate with the Developer Console (the endpoint/gateway authoring UI, gated by `CONSOLE_TOKEN`, structurally absent from QA/Production per `DEPLOYMENT_ARCHITECTURE_NOTES.md` and `scripts/checkDataPlaneBundle.js`), so it's worth being explicit about why it's a separate concept with its own name rather than a mode of the existing one:

- **Opposite environments.** The Developer Console exists *only* in development and is deliberately absent from QA/Production. The Ops Console exists specifically *for* QA/Production -- observing and operating a running instance, not authoring its config.
- **Opposite capability shape.** The Developer Console lets a developer *change* what an instance does (create endpoints, edit gateways). The Ops Console mostly *observes* a running instance; its only genuinely mutable surface is a small set of its own runtime settings (the capture toggle and its size caps, below) -- never business configuration.
- **Different trust exposure.** A Developer Console breach on a developer's own laptop is bad but contained. An Ops Console breach in Production is categorically worse -- it can expose environment variables, request/response bodies, and (if capture is on) customer data flowing through real traffic. It needs to be treated as a higher-value target than `CONSOLE_TOKEN` ever was, not a parallel feature with the same assumptions.

**Naming decided: "Ops Console."** Avoids reusing "Admin" right after the Admin Portal → Developer Console rename resolved exactly this kind of ambiguity -- a second thing also called "Admin" would undo that. **Its own token is named `OPS_TOKEN`** to match (not `ADMIN_TOKEN`, despite the original ask using that word generically) -- confirmed.

## Where it runs

**Decided: mounted inside the same process as the data plane, per instance**, not a separate admin-only deployment. Simplest to build and deploy -- no new service, no new infra -- and consistent with how `coreApp.ts` already composes shared concerns (health, `/auth`, the dispatcher) into whichever entry point mounts it.

**Decided: mounted in `coreApp.ts`.** That module is already shared by `app.ts` (dev), `dataPlaneApp.ts` (QA/Production), so mounting the Ops Console there gets it into all three targets automatically -- including dev, which is genuinely useful for testing the Ops Console itself before it ever reaches QA/Production.

**Per-instance, designed for future aggregation.** Metrics, logs, and captured requests all live in that one process's memory -- reset on restart, invisible to any other instance in the fleet. Every data-producing response (`/ops/api/system`, `/ops/api/metrics`, `/ops/api/logs`, `/ops/api/captures`) is tagged with an instance identifier (hostname + PID, or a configurable `INSTANCE_ID`) so a later "scrape every instance and merge" fleet view is an additive change to how the data is *consumed*, not a rewrite of how it's *produced*.

## Auth: `OPS_TOKEN`, mirroring `consoleAuth.ts` exactly

A new `opsAuth.ts`, structurally identical to the existing `consoleAuth.ts`: `requireOpsAuth` gates every `/ops/api/*` request behind a bearer token read from `OPS_TOKEN`; if unset, the Ops API is disabled outright (`503 OpsDisabled`) rather than ever running unauthenticated, same reasoning as the Developer Console's own gate -- this surface can reveal environment variables and (optionally) live customer traffic, which is at least as sensitive as "can configure an endpoint that calls an arbitrary URL." Token comparison uses `crypto.timingSafeEqual`, same convention.

**Recommend, as an operational note rather than something this app enforces in code:** `OPS_TOKEN` alone is probably not enough for a Production-facing surface this sensitive. Consistent with `DEPLOYMENT_ARCHITECTURE_NOTES.md`'s existing stance that infrastructure config is deployment-owned, the Ops Console route should ideally sit behind a network boundary (internal-only listener/port, VPN, or an infra-level IP allowlist) in addition to the token -- the same spirit as "never put `CONSOLE_TOKEN` on the public load-balancer path," just for a surface that's now intentionally present where `CONSOLE_TOKEN` never was.

## Feature: environment variables -- view-only, not "manage"

Scoping this down from "manage" to "view, with secrets masked." Two reasons:

- Most of this app's config is read once at process startup (`CONFIG_DIR`, `PORT`, `REDIS_URL`, etc. -- see `dataPlaneServer.ts`'s own `resolveStartupPaths()`), so a live edit through a web form wouldn't take effect without a restart, and a UI that implies otherwise would be actively misleading during an incident.
- `DEPLOYMENT_ARCHITECTURE_NOTES.md` already made the deliberate call that infrastructure config is deployment-owned -- provisioned identically to every instance via env vars/secrets manager/Terraform, not edited through this app's own UI. An env var editor would quietly contradict that decision.

`GET /ops/api/env` returns the current `process.env` map with any key matching `secretRedaction.ts`'s existing `SENSITIVE_KEY_PATTERN` masked to `REDACTED` -- reusing that one regex rather than inventing a second redaction convention for the same concern.

## Feature: system monitoring

Low-risk, no new dependency: `process.cpuUsage()`, `process.memoryUsage()`, `os.loadavg()`, `os.totalmem()`/`os.freemem()`, `process.uptime()`, sampled on an interval (e.g. every 5s) into a small ring buffer so the UI can show a short recent trend, not just a single instantaneous snapshot. `GET /ops/api/system` returns the latest sample plus that short history.

## Feature: per-endpoint throughput, latency, and errors

No instrumentation exists for this today -- it's new code, not a config toggle. The natural hook is `dispatch.ts`'s `createDynamicDispatcher`, the single middleware every configured endpoint already funnels through by construction (per its own doc comment). Wrapping that call records a start time, measures duration on response finish, and buckets the result by `endpoint.id`: request count, total/min/max duration, counts by HTTP status class (2xx/4xx/5xx), and counts by this app's own error types (`ValidationError`, `BackendError`, `AuthError` -- see `src/server/errors.ts`) for "any other error," not just HTTP status codes.

New `opsMetrics.ts` holds this as an in-memory `Map<endpointId, Stats>`. **Decided: counters reset only on process restart** -- no manual "reset counters" UI action. A deploy already restarts the process, which already clears the in-memory map, so the one case this would matter for is already covered without extra UI. `GET /ops/api/metrics` returns the full map plus the instance tag.

## Feature: real-time logs and export

`src/server/logger.ts` already wraps `pino`. Add a bounded in-memory ring buffer that a custom `pino` destination also writes to (last N entries or last N MB, whichever limit hits first) -- this avoids depending on where/whether `pino`'s own output ends up on disk, which varies by deployment. **Decided: the buffer's size limit is runtime-configurable**, the same way the capture size caps are -- it joins `opsRuntimeSettings.ts` (env-seeded default, live-adjustable from the Ops Console, never persisted) rather than being a fixed constant, so "temporarily capture more" is one consistent kind of knob across logs and request/response capture alike. Real-time delivery to the browser via Server-Sent Events (`GET /ops/api/logs/stream`) needs no new dependency, unlike a WebSocket library. `GET /ops/api/logs` returns a point-in-time dump of the current buffer; `GET /ops/api/logs/export` offers it as a downloadable file.

## Feature: request/response capture, including the backend call

The highest-risk feature, and the one most worth getting the design right on before writing code. Refined per your answers to the brainstorm:

**A single global toggle, not per-endpoint.** `OPS_CAPTURE_REQUESTS_RESPONSES` provides the *startup default* (off unless explicitly set); the Ops Console UI additionally exposes a live on/off switch that overrides it instantly, per instance, without a restart. This switch is intentionally **not** persisted anywhere -- it lives only in that process's memory and reverts to whatever the env var says the next time the process restarts. That's a deliberate fit for an incident-response tool: flip it on while debugging something live, flip it off (or just restart) when done, with no risk of a forgotten setting silently surviving into the next deploy.

**When on, it captures every endpoint uniformly** -- no per-endpoint allow/deny list for v1, matching your answer.

**What gets captured, and redacted, per request:**
- The inbound request: method, path, matched `endpointId`, headers, and body.
- The outbound response: status and body.
- The backend call `connectors/index.ts`'s `callBackend()` actually made: for JSON/XML/SOAP gateways, the outgoing request (URL, headers, body) and the raw response body; for SQL gateways, the compiled query text plus the result.

**Redaction, extended from the existing convention rather than reinvented:**
- For JSON bodies (and headers, which are already flat objects): reuse `secretRedaction.ts`'s recursive `redact()`, which already knows how to walk an arbitrary object and mask any key matching `SENSITIVE_KEY_PATTERN` -- plus unconditionally stripping `Authorization` and cookie headers regardless of name-matching, since those are credentials by position, not by name.
- For XML/SOAP bodies, which are strings rather than objects: **decided -- parse, redact, re-serialize.** Parse the body into a structured form, walk it the same way the JSON redactor walks an object (masking element/attribute values whose name matches `SENSITIVE_KEY_PATTERN`), then serialize it back, rather than regex-matching the raw string. More implementation work than a regex pass, but XML has no single canonical "key name" the way a JSON object does, so a raw-string regex would be the less rigorous of the two and more likely to miss or over-match.
- For SQL: there's no key-name signal to selectively mask by -- bind parameters are positional/named values, not a JS object with sensitive-sounding field names. Recommend redacting **every** bound parameter value unconditionally when capturing a SQL call (the query *shape* is useful for debugging; the actual values are exactly the kind of caller-supplied input -- ids, search terms, lookups -- this middleware exists to proxy, and therefore exactly what shouldn't end up sitting in a capture buffer). The result is never logged in full: row count plus a small, capped sample of redacted rows, never the complete result set -- a real query could return an entire table.

**Size caps: configurable at runtime, not fixed.** Per your answer, both the per-body size cap (for JSON/XML/SOAP request/response capture) and the SQL sample-row cap need to be adjustable live from the Ops Console, not baked in as constants -- so an operator can temporarily raise them while actively debugging something that needs a larger capture, then lower them again. This lives in the same place and follows the same lifecycle as the capture on/off switch: an in-memory, per-instance settings object, seeded from env vars at boot (sane defaults -- proposed starting points: ~4KB per captured body, 20 rows for a SQL sample, both easy to revisit), mutable live via the Ops Console, never persisted to a config file. Grouping the toggle and the size caps into one small `opsRuntimeSettings.ts` module (`{ captureEnabled, maxCapturedBodyBytes, maxSqlSampleRows }`) with a single `GET /ops/api/settings` / `PUT /ops/api/settings` pair (both `OPS_TOKEN`-gated) keeps this as one coherent concept rather than three independent toggles, and is also the natural extension point for whatever future runtime-adjustable setting gets added next.

**Storage:** a bounded ring buffer (capped by entry count and/or total bytes, oldest evicted first) so the capture feature itself can't become the thing that exhausts an instance's memory. `GET /ops/api/captures` lists recent entries, filterable by `endpointId`.

**Every settings change is logged** (via the existing `pino` logger, at `warn` or above) -- who/when/what changed, given this toggle controls a compliance-sensitive capability. **Decided: that log line is enough** -- no separate "recent changes" panel or backing store; the existing real-time logs/export panel is where an operator would already look.

## Extensibility: a panel registry, not one monolithic router

Per "we'll likely add more features later": structure `opsApi.ts` as a small registry of named panels (`system`, `metrics`, `env`, `logs`, `captures`, `settings` today), each contributing its own route(s) and its own section of the UI, rather than one router file that grows a new special case per feature. A future panel (feature flags, a cache-invalidation button, whatever comes next) is then an addition to the registry, not a change to existing panels.

## Proposed module layout

New files, mirroring the existing `console*`/`ops*` naming convention this project already uses for parallel subsystems:

- `src/server/opsAuth.ts` -- `requireOpsAuth`, mirroring `consoleAuth.ts`.
- `src/server/opsRuntimeSettings.ts` -- the capture toggle, configurable capture size caps, and the log ring buffer size limit, env-seeded, UI-mutable, never persisted.
- `src/server/opsMetrics.ts` -- per-endpoint counters, fed by a `dispatch.ts` wrapper; the CPU/memory sampler.
- `src/server/opsLogBuffer.ts` -- the bounded ring buffer (sized from `opsRuntimeSettings`) fed by a custom `pino` destination, plus the SSE stream.
- `src/server/opsCapture.ts` -- the request/response/backend-call recorder, gated by `opsRuntimeSettings`, using extended `secretRedaction.ts`-style redaction.
- `src/server/opsApi.ts` -- the panel registry and router tying the above together, mounted (see "Where it runs") behind `requireOpsAuth`.
- `public/ops/` -- the static UI (its own `index.html`/`ops.js`/`ops.css`), structurally parallel to `public/console/`.

**`scripts/checkDataPlaneBundle.js` needs a comment update, not a logic change.** Its `FORBIDDEN` list is specific to Developer-Console identifiers and doesn't need Ops Console entries -- Ops code is *supposed* to be in the QA/Production bundle, that's the entire point of this feature. But its doc comment currently reads as "no admin-shaped code belongs in these bundles" in spirit, and a future reader seeing Ops Console code land right next to that check could reasonably wonder whether it's a regression. Worth tightening the comment to say explicitly: this check is about the Developer Console (endpoint/gateway authoring) specifically, not admin-shaped code in general, now that a second, intentionally-included admin-shaped subsystem (Ops Console) exists.

## Decided

- **Name: "Ops Console"** -- deliberately distinct from "Developer Console," to avoid reintroducing the ambiguity that rename just resolved.
- **Mounted in `coreApp.ts`** -- dev, QA, and Production all get it, since that module is already shared by all three entry points; useful for testing the Ops Console itself before it ever reaches Production.
- **Runs inside the same process as the data plane, per instance** -- no separate admin deployment, no new infrastructure.
- **Data is per-instance, but shaped for future fleet aggregation** -- every response is tagged with an instance identifier so a later "scrape and merge" view is additive.
- **Its own token, `OPS_TOKEN`** (not `ADMIN_TOKEN`, to stay consistent with the console's own name) -- gating every `/ops/api/*` route with the exact same pattern as `consoleAuth.ts` (fail closed if unset, `timingSafeEqual` comparison).
- **Environment variables are view-only**, never edited through this UI, with secrets masked using the existing `SENSITIVE_KEY_PATTERN` convention -- consistent with "infrastructure config is deployment-owned" from `DEPLOYMENT_ARCHITECTURE_NOTES.md`.
- **Per-endpoint metrics are built new**, hooked into `dispatch.ts`'s single dynamic dispatcher, in-memory. **Counters reset only on process restart** -- no manual reset action, since a deploy already restarts the process.
- **Request/response/backend-call capture is a single global toggle**, not per-endpoint, off by default, live-adjustable per instance without a restart, never persisted.
- **Capture is always redacted** -- JSON/headers via the existing recursive `redact()`; XML/SOAP bodies via parse-redact-reserialize (not a raw-string regex pass), since XML has no single canonical "key name" the way JSON does; SQL bind parameters redacted unconditionally (no key-name signal exists to be selective there); SQL results as row-count-plus-capped-sample, never a full dump.
- **Capture's size caps (body size, SQL sample rows) AND the real-time log ring buffer's size are all runtime-configurable**, not fixed constants -- live-adjustable from the Ops Console, env-seeded defaults, never persisted, grouped together in one `opsRuntimeSettings` module as one consistent "temporarily turn this up" mechanism.
- **Runtime-settings changes are logged via the existing `pino` logger** (who/when/what changed) -- no separate "recent changes" panel or backing store.
- **Built as a panel registry**, not a monolithic router, so each feature (and whatever gets added later) is a self-contained addition.

## Open questions still needing a decision

None remaining -- this topic is fully worked through for now.
