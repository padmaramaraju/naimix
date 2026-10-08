# Custom Transform Functions — Design Notes

**Status: implemented.** Captured for reference alongside `AUTH_DESIGN_NOTES.md`, `OPS_CONSOLE_DESIGN_NOTES.md`, and `DEPLOYMENT_ARCHITECTURE_NOTES.md` — this records the decisions actually made (and why), not a pre-implementation brainstorm.

## The problem

`output.fields[].transform` was a fixed enum (`toString`/`toNumber`/`toBoolean`/`trim`/`upper`/`lower`) and there was no way to add, remove, or restructure fields beyond what a flat JSONPath extraction can express, or to walk/rewrite an array once it's been mapped. Users needed to: modify a single output value with arbitrary logic, add or delete output parameters, and navigate/rewrite a mapped array — at either the single-field level or across the whole endpoint response.

## Two hook points, not one generic one

- **Field-level**: `OutputValueFieldDef.transform` can now be either the existing enum OR `{ kind: "function", name }` (`FunctionTransformRef`, see `src/types/config.ts`). Called as `(value, ctx) => value | undefined` — returning `undefined` omits the field, the same way a missing `default` already does, so field-level delete falls out for free.
- **Endpoint-level**: a new `OutputConfig.postProcess?: { name }`, run once in `mapResponse()` (see `src/transform/mapper.ts`) on the ENTIRE mapped result object — including any field that's itself a list, via a top-level `OutputArrayFieldDef` — after every field has already been extracted. This is where add/remove-arbitrary-fields and array-walking logic live, since a field-level function only ever sees one field's own value.

Both call the identical `(data, ctx) => data` shape (`TransformFunction` in `src/transform/functionRegistry.ts`), with `ctx` carrying `{ item, raw, params }`. There is deliberately no separate "field function" vs "endpoint function" concept in storage — the same registered name can be referenced from a field's `transform` and from `postProcess` interchangeably (see `mapper.test.ts`'s "same function, both roles" coverage).

## Named-function registry, not inline eval

Functions are real files — `<configDir>/transforms/<name>.ts` (source) and `<name>.js` (compiled CommonJS, what actually runs) — loaded into an in-memory `Map<name, fn>` by `FunctionRegistry` (`src/transform/functionRegistry.ts`). A config references a function purely by name; `endpointRegistry.ts` validates every referenced name against the registry at load/save time (`src/transform/functionRefs.ts`), the same "a bad reference is a load/save error, not a silent no-op" rule a bad gateway name already gets — logged and skipped for one bad file, never crashing the whole server (`reloadFromDisk()`), or a clean 400 immediately on save (`upsert()`).

`FunctionRegistry` uses plain CommonJS `require()`/`require.cache` deletion (this project's own module format — see `package.json`'s `"type": "commonjs"`), not a dynamic ESM `import()`: a compiled transform file is just another internal module as far as Node's module system is concerned, and cache deletion is the standard way to force a fresh `require()` of a path already loaded once.

## Dev Console: dynamic and sandboxed. QA/Production: static and restart-only. By policy, not by accident.

- **Developer Console** (`consoleApi.ts`'s `/functions/*` routes, dev-only — structurally absent from the QA/Production build, same guarantee `scripts/checkDataPlaneBundle.js` already enforces for the rest of the console): a code editor (TypeScript or plain JS) with a **Test** button that compiles the typed-but-not-yet-saved source with esbuild (`functionCompiler.ts`'s `compileFunctionSource`) and runs it in a bare `vm.Context` (`runInSandbox`) — no `require`/`process`/`fs`/network, a hard execution timeout, console output captured instead of reaching the real stdout. This is the ONLY place untrusted-while-being-written code ever executes. **Save** writes both the `.ts` source and the compiled `.js` to `<configDir>/transforms/`, then hot-reloads it into the dev server's own live registry (`FunctionRegistry.reloadOne()`, cache-busted `require()`) so an endpoint referencing it works on the very next request — no `npm run dev` restart needed.
- **QA/Production** (`dataPlaneServer.ts`): `FunctionRegistry.loadFromDisk()` runs exactly once, at process boot, scanning `<configDir>/transforms/*.js`. Nothing in `dataPlaneApp.ts`/`opsApi.ts` ever calls `reloadOne()`/`remove()` — there is no route, no dynamic re-require, nothing watching the filesystem. Getting a new or edited function live on QA/Production is: `git pull` the configDir repo, restart the process — identical to how every other config change there already works (confirmed: QA/Production has no live-reload-without-restart capability at all today, for anything, not just this feature). **This is a deliberate, final security boundary, not a missing feature** — esbuild and the `vm` sandbox are devDependencies/dev-only code paths and never reach the QA/Production bundle at all.

## Git parity with endpoints/gateways

The active `configDir` (endpoints + `gateways.yaml`) is typically its own git repo, independent of the `naimix` application code repo — that's the whole point of a swappable workspace. Putting transform functions in `src/transforms/` (part of the app repo) would have broken that parity and tied a function edit to an app rebuild+redeploy. Instead, `<name>.ts`/`<name>.js` live inside `configDir/transforms/`, alongside `gateways.yaml` and `endpoints/` — same repo, same `git add/commit/push`, same "Change workspace" switch (which now also repoints the function registry — see `consoleApi.ts`'s `PUT /settings`).

## The trade-off this accepts

Before this feature, a `configDir` git pull + reload could only ever change *data* (YAML can't execute anything). Now a pull + **restart** on QA/Production can introduce and run new code. Deliberately scoped: restart is always required (no path loads code without one), so whoever has push access to the configDir repo has, in effect, code-deploy access gated by a restart — not something this app tries to prevent further, per the user's explicit call that this boundary "will remain that way for security reasons."

## Scope not covered (v1)

- Auth providers' `claims` extraction (`basicLogin.ts`/`oauth2.ts`) reuses `mapItem()` and would technically support a function-kind `transform` too, but neither has a Console UI for it and `mapItem()`'s `functions` param defaults to `undefined` there — untested combination, not a guaranteed-working one.
- Functions are pure and synchronous only (no `async`/`await`, no network/DB calls) — confirmed with the user as the intended scope, keeping sandboxing and timeouts meaningful.
- No "delete a function" confirmation beyond the existing dependents check (`DELETE /console/api/functions/:name` 409s if any endpoint still references it, mirroring `DELETE /gateways/:name`).
