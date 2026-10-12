# Shared Workspace & Apps — Design Notes

**Status: design finalized, implementation starting.** All open questions below are resolved. `deployment.yaml.example` and the matching `.gitignore` entry are built; everything else (Integration/App/Route types, schema, registries, migration, server boot changes on both entry points, the Console UI rework, basePath/mounts) is being built next, as one continuous push rather than staged with review in between. A clickable visual mockup of the Console UI exists (a Claude artifact, not part of this repo) and already validated the look and feel.

## Final decisions (resolving the open questions below)

- **Hard cutover.** The old Endpoint format (`method`/`path` baked into the same file as `input`/`backend`/`output`) stops being read once this ships. A migration script converts every existing `endpoints/*.yaml` file into an Integration (same file, minus `method`/`path`) plus a Route entry in one default App, preserving today's exact URLs (that default App's `basePath` is empty/root). Same philosophy as the `output.root` removal: loud and immediate, no compatibility shim.
- **Route gets its own "Try it" tester** in the Console, separate from the existing Integration-level Test tab (which stays as today).
- **App gets a stable `id` (slug) distinct from its editable display `name`.** Route gets its own stable `id` distinct from its `method`+`path`. Both for the same reason `basePath` is decoupled from App name: renaming a label shouldn't silently break something that references the underlying entity (a `deployment.yaml` `mounts` entry, in App's case; the Console's own edit-in-place UI, in Route's case).
- **Full rename, not UI-only**: `endpoints/` folder → `integrations/`; `EndpointConfig` type → `IntegrationConfig` in code. Matches how the `output.root` removal was done — type system and file layout renamed along with the UI label, not left half-done.
- **Route path-param collision checking is required, not optional** — confirmed against the real repo rather than left as a hypothetical: `config/endpoints/api/{soap,xml,json,sql}/customers/[id]/*.yaml` already use Express-style `:id` path params today (e.g. `/api/xml/customers/:id`). So the method+path collision check (within an App) and the future basePath-uniqueness check (across Apps on one server) both need to normalize `:param` segments to a common placeholder before comparing — `/customers/:id` and `/customers/:slug` are a real collision, not just a theoretical one, because Express would route either one to whichever route was registered first.

## The problem

Today, a "Workspace" is one `configDir` folder (one Git repo): `endpoints/`, `gateways.yaml`, `authProviders.yaml`, `transforms/`. A running server points at exactly one Workspace and serves everything in it. There's no way to reuse a Gateway, Auth Provider, or Endpoint across more than one backend-for-frontend without duplicating it into another Workspace.

The goal: let Gateways, Auth Providers, and Endpoints be defined once, maintained by a central platform team, and referenced by multiple teams who each build their own backend-for-frontend out of a subset of that shared catalog — "mixing and matching" rather than duplicating.

## Core model: Workspace vs. App

Two ownership domains, replacing today's single "one workspace, one server, serves everything" model:

- **Workspace** (labeled "Shared Collection" in the Console UI) — Auth Providers, Gateways, Integrations, and custom transform Functions. Centrally maintained; referenced by every App that needs it. The underlying concept keeps the name "Workspace" in code/config (`configDir` still points at one); "Shared Collection" is the UI-facing label chosen specifically to avoid the old ambiguity where "workspace" used to mean "the one thing a server runs."
- **App** — owned by a consuming team. A flat list of **Routes**, each a thin pointer: public `method` + `path` + `description`, plus the name of the Integration it calls. An App contains no backend-calling logic of its own; it only assembles routes out of what Shared Collection already offers.

This directly mirrors established API gateway patterns — Kong's Service/Route split, AWS API Gateway's Integration/Resource split — rather than being a novel design. **Decided**: lean on that precedent rather than inventing something bespoke.

### Splitting today's Endpoint

Today's single `EndpointConfig` (`id, description?, method, path, input?, backend, output`) splits in two:

- **Integration** (Workspace-owned) — keeps `input`, `backend`, `output`: how to call a backend and shape its response. This is today's Endpoint minus the public-facing `method`/`path`.
- **Route** (App-owned) — today's "Basic tab": `method`, `path`, `description`, plus which Integration it calls, by name.

**Naming — decided**: "Integration," not "Backend" or "Operation" or "End Point."
- "Backend" was rejected: it collides with the existing `backend` field already nested inside this entity (`backend: { type, gateway, url, ... }`) — "an Integration's backend" reads fine, "a Backend's backend" doesn't.
- "Operation" was rejected: OpenAPI already uses that term for the *opposite* concept (method + path), which is what we're calling "Route."
- "Integration" matches the term AWS/Kong already use for this exact concept, so it's immediately recognizable to anyone who's touched an API gateway before.

**Route is a pure pointer for v1 — decided**: a Route carries no `input`/`backend`/`output` overrides of its own, only `method`, `path`, `description`, and the Integration it references. If a team needs different call or mapping behavior, the answer is to define a *different* Integration against the same Gateway, not to parameterize at the Route level. Keeps v1 simple; revisit only if a real case shows up where this doesn't hold.

### Auth composes for free

`requiresAuth` already lives on the *Gateway* today (every `GatewayConfig` variant has it), not per-Endpoint — it means "every Endpoint calling through this Gateway requires the caller to present a token from the named AuthProvider." Under the Route/Integration split, a Route automatically inherits whatever auth its Integration's Gateway already requires. **Decided**: no new Route-level or App-level auth concept is needed — this was a real risk worth checking (confirmed by rereading `GatewayConfig`'s actual `requiresAuth` doc comments) and it turns out the existing mechanism already composes correctly with zero changes.

### Multi-workspace question — deferred, then resolved

Original open question: can one App pull Integrations from more than one Workspace? Under the Route/Integration split this narrows to a pure reference-resolution question — which Workspace(s) does resolving a Route's `integration` name search.

**Decided for v1**: one Workspace per App. Extending the lookup to an ordered list of Workspaces later is additive (a small change to how a name is resolved), not a redesign — so there's little cost to deferring it until a real need (e.g. the central team's catalog itself splitting across more than one repo) shows up.

## Storage: same repo for v1

**Decided**: Apps live in the same Git repo as their Workspace, in a new top-level `apps/` folder — one YAML file per App (not one file per route, unlike `endpoints/` where each Integration is a meatier object and keeps its own file):

```yaml
# apps/storefront-web.yaml
app: storefront-web
routes:
  - method: GET
    path: /categories
    integration: categories
    description: Category nav tree
```

Rationale: resolving a Route's `integration` reference is then a trivial in-process lookup against a Workspace already loaded into memory — no cross-repo or network resolution to build, and almost no change to the server's existing boot sequence. A separate repo per App (true independent ownership and release cycle per app team) is the more "real" end state for genuinely independent teams, but costs much more up front (the server would need to load two repos at boot, and the Console would need a cross-repo story) and is left as a possible future migration — additive, not a redesign, if a team later needs it.

## Preventing accidental route collisions

**Decided**: validate at two points, both "loud error, never silent," consistent with how an unknown Gateway/AuthProvider/transform-function reference already fails today rather than being silently dropped:

1. **Load time** — when an App's YAML file is read (server boot, or a Console reload), any two routes in that file sharing the same `method` + `path` fail loading, loudly. This is the backstop for the case two developers each add a route in a separate commit: Git merges the file cleanly (they touched different list entries), but the merged result is semantically broken. Only a check that runs on the merged file catches that — recommend wiring this into CI on PRs, not just server boot.
2. **Save time, in the Console** — adding or editing a Route checks the new `method`+`path` against every other route already in that App (excluding itself) before writing, rejecting with a message naming the exact conflicting route. Same shape as the existing `uniqueTargetName` check already used for output-field target names in the Console's tree picker — reuse that pattern, including live as-you-type feedback in the Add Route modal.

**Decided**: Routes do support path parameters (today's Endpoints already use them), so the comparison always normalizes parameter segments to a placeholder before comparing — `/products/:id` and `/products/:slug` are a genuine collision (any real request is ambiguous between them) even though the literal strings differ.

**Scope — decided**: collision checking is per-App only, not global across every App in the repo, since in the base model each App deploys as its own server process. (Revisited below once multiple Apps can share one server.)

## Hosting multiple Apps on one server

A customer may want several Apps served by one running process rather than one process per App. **Decided**: give every App its own `basePath`, prepended to all its routes — e.g. `/storefront-web/categories` — the same approach AWS API Gateway's base path mappings and Kong's route prefixes already use for this exact problem.

Refinements on top of "just prepend the app name":

- `basePath` is an **explicit, independently-editable field**, not auto-derived from the App's display name. Decouples the public URL surface from an internal label that might get renamed later for unrelated reasons.
- **Every App gets a `basePath`, even when it's the only one on a server.** If a lone App were mounted at the root with no prefix, adding a second App to that server later would force a breaking choice: retroactively prefix the first App's URLs (breaking its existing clients), or leave a permanently inconsistent one-App-at-root-the-rest-prefixed setup. Requiring a `basePath` from day one avoids this for free.

This upgrades route-collision checking to two tiers:
1. Within an App — `method`+`path` uniqueness, as above.
2. Across Apps sharing one server — `basePath` uniqueness, checked only among the Apps actually configured to be mounted together on that particular server (not globally across the repo, since two Apps never deployed together can safely reuse the same `basePath`).

**Knock-on effect**: OpenAPI/MCP export (already scoped per-App — see below) must bake the App's `basePath` into exported paths once it's mounted, since that's the real public path a client would call.

## Deployment configuration: `deployment.yaml`

**Decided**: replace `data/settings.json` (today's sole persisted setting, `{ configDir }`) with a new `deployment.yaml` that holds both `configDir` and the new `mounts` list — which App(s) this particular server instance serves, and at what `basePath` each:

```yaml
configDir: /path/to/your/workspace-repo/config
mounts:
  - app: storefront-web
    basePath: /storefront-web
  - app: partner-mobile
    basePath: /partner-mobile
```

Two reasons to combine rather than just adding `mounts` alongside `configDir` in some other file:
- `mounts` is meaningful operational config — which Apps are actually live on this server, and where — deserving the same treatment (reviewed, reproducible per environment) as any other deployment config, not treated as throwaway runtime state.
- It incidentally fixes an existing inconsistency: `settings.json` was the only JSON file in an otherwise all-YAML config system.

**Decided**: treat `deployment.yaml` exactly like `.env` / `.env.example` — a checked-in `deployment.yaml.example` template with placeholder values and explanatory comments, while the real `deployment.yaml` is hand-edited/created per environment (local dev, staging, a customer's production server) by whoever is deploying, and is **not** committed. Implemented for real: `deployment.yaml.example` now sits at the repo root next to `.env.example`, and `deployment.yaml` was added to `.gitignore` alongside `.env`.

**Incidental finding, not yet acted on**: `data/settings.json` — the file this replaces — was discovered to already be tracked in Git today, despite `.env.example`'s own comment calling it "a per-machine preference file — don't check it into Git." A pre-existing inconsistency. Not fixed, since `settings.json` is being phased out anyway, but worth knowing so the same mistake isn't repeated with `deployment.yaml` (hence gitignoring it proactively).

**Still open**: whether `mounts` needs its own environment-variable override for quick local testing, the way `CONFIG_DIR` overrides `configDir` today. Left for later — add only if it turns out to be needed.

## Console UI redesign

**Decided — navigation shape**: a single sidebar with two visually distinct sections, rather than a top-level mode switcher or a flat tab bar with Apps bolted on as one more tab. "Shared Collection" (Auth Providers, Gateways, Integrations) sits above "Apps" (a flat list — no folder nesting). This was chosen over the alternatives because it lets someone building a Route browse the catalog in place while building, and lets the central team see "who's using this Integration" without switching modes.

**Decided — Apps layout**: a flat list of Apps in the sidebar; clicking one shows its Routes in the main panel.

**Decided — making the ownership split visually obvious**, since the whole point is that these are two different domains with (eventually) different write access:
- A distinct accent color per section, reused everywhere that section's content appears — not just the sidebar, but also the small pill shown wherever a Route displays which Integration it calls. Seeing the same color/pill style in a Route row teaches "this is a pointer into the shared catalog, not something this App owns" without needing a label.
- That Integration pill is clickable and cross-navigates straight into Shared Collection, highlighting the exact Integration it points to.
- A one-line caption under each section header stating who maintains it and who it's for.
- The Integration picker in the Add Route flow renders as read-only reference cards (name, Gateway, description, a "View in Shared Collection ↗" escape hatch) rather than anything that looks editable in place.
- An explicit empty-state message when an App has no routes yet, and another when Shared Collection has no Integrations yet, each naming where the thing actually gets created.

**Decided — export**: OpenAPI Spec and MCP downloads move from workspace level to App level, scoped to only that App's routes (and, once multi-app-hosting exists, that App's `basePath`-prefixed paths).

**Decided**: yes, Routes get their own lightweight "Try it" tester (hits the real method+path, confirms it resolves to the right Integration) separate from the existing Integration-level Test tab (which stays as today — testing the backend call + mapping, independent of any App).

**Looking ahead, not yet needed**: once real multi-user permissions exist, Shared Collection screens would naturally become read-only for most people and editable only by whoever holds the central-team role — the visual language chosen above (color coding, read-only-looking cards, cross-nav rather than inline edit) already anticipates this without requiring it to exist yet.
