import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

/** What a custom transform function is called with and must return. Used
 * identically for a field-level `transform` (data = that one field's
 * extracted value) and an endpoint-level `postProcess` (data = the whole
 * mapped output) -- see FunctionTransformRef/OutputConfig.postProcess's
 * doc comments in src/types/config.ts. Pure and synchronous on purpose
 * (see TRANSFORM_FUNCTIONS_DESIGN_NOTES.md): no async/await, no network or
 * DB calls from inside a transform. */
export type TransformFunction = (
  data: unknown,
  ctx: { item?: unknown; raw?: unknown; params?: Record<string, unknown> }
) => unknown;

export interface FunctionLoadError {
  file: string;
  error: string;
}

/**
 * Loads named custom transform functions from compiled CommonJS .js files
 * in a directory (`<configDir>/transforms/*.js` -- see
 * TRANSFORM_FUNCTIONS_DESIGN_NOTES.md). Each file is expected to end with
 * `module.exports = transform;` (the Developer Console writes this
 * automatically when it compiles a saved function -- see consoleApi.ts's
 * POST /functions/:name); the registered name is the file's basename
 * without the `.js` extension.
 *
 * Two very different lifecycles share this one class, by design:
 *  - QA/Production call loadFromDisk() exactly once, at process boot (see
 *    dataPlaneServer.ts), and NEVER call reloadOne()/remove() after that --
 *    getting a new or edited function live always requires a real process
 *    restart. This is a deliberate security boundary, not a missing
 *    feature: nothing in dataPlaneApp.ts/dataPlaneServer.ts/opsApi.ts ever
 *    calls the dynamic-reload methods below, only consoleApi.ts (which is
 *    structurally absent from the QA/Production build -- see
 *    scripts/checkDataPlaneBundle.js) does.
 *  - The Developer Console calls loadFromDisk() once at its own boot, same
 *    as QA/Prod, but ALSO calls reloadOne() right after writing a new/
 *    edited function to disk (see consoleApi.ts's save route), so an
 *    endpoint built against it picks up the edit on the very next request
 *    without restarting `npm run dev` -- the same "no restart needed"
 *    experience editing an endpoint or gateway already has.
 *
 * Each file is loaded via requireExact() (below), not a plain require()
 * call -- see that function's own doc comment for why: a plain
 * require(fullPath) is vulnerable to a loader (tsx's, under `npm run
 * dev`) silently resolving a `.js` request to a same-named `.ts` sibling
 * instead, which is exactly the file pairing this registry's own save
 * flow creates. requireExact() sidesteps that by compiling the exact
 * file's own content directly, with no resolution step for any loader to
 * act on.
 */

/**
 * Loads one compiled transform file by its EXACT path, bypassing
 * require()'s normal module resolution entirely. Under `npm run dev`
 * (tsx), require()'s resolver silently substitutes a same-named `.ts`
 * sibling for a `.js` request whenever one exists -- exactly the pairing
 * this registry's own save flow creates on purpose (the Console keeps
 * both the compiled `<name>.js` that actually runs and the human-authored
 * `<name>.ts` it displays for editing, side by side in the same folder --
 * see consoleApi.ts's PUT /functions/:name). That `.ts` sibling is just
 * the author's bare function declaration with no `module.exports` of its
 * own, so the substitution silently loads the WRONG file and this
 * function then looks like it exports nothing at all (confirmed via a
 * live diagnostic: require.resolve() of a path ending in `.js` came back
 * pointing at the `.ts` file instead -- see the Oct 2026 investigation
 * into "categoryPath.js does not export a function").
 *
 * Since the caller already knows the exact path (it just listed the
 * directory itself), there's no ambiguity left for any resolver hook to
 * act on -- building the CommonJS module directly from that path's own
 * file content, instead of asking require() to go find it, sidesteps the
 * resolution step (and any hook watching it, tsx's or otherwise)
 * entirely. `_nodeModulePaths`/`_compile` are undocumented but
 * long-stable Node internals -- the same mechanism several well-known
 * tools (e.g. pirates, proxyquire) use for exactly this "load this exact
 * file as CommonJS, no resolution" need.
 */
function requireExact(fullPath: string): unknown {
  delete require.cache[fullPath];
  const code = fs.readFileSync(fullPath, "utf8");
  const mod = new Module(fullPath, module);
  mod.filename = fullPath;
  mod.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(
    path.dirname(fullPath)
  );
  (mod as unknown as { _compile(code: string, filename: string): void })._compile(code, fullPath);
  require.cache[fullPath] = mod as unknown as NodeJS.Module;
  return mod.exports;
}

export class FunctionRegistry {
  private functions = new Map<string, TransformFunction>();

  constructor(private dir: string) {}

  /** The directory this registry is currently reading from. */
  getDir(): string {
    return this.dir;
  }

  /** Repoints this registry at a different transforms folder and reloads
   * from it immediately -- mirrors EndpointRegistry.setDir(), used by the
   * same "Change workspace" flow (see consoleApi.ts's PUT /settings) so a
   * workspace switch swaps the active transform functions along with the
   * endpoints/gateways that reference them. */
  setDir(dir: string): { errors: FunctionLoadError[] } {
    this.dir = dir;
    return this.loadFromDisk();
  }

  /** One-time scan of every *.js file in `dir`, replacing the current
   * in-memory set entirely. A missing directory is NOT an error -- a
   * brand-new configDir with no transforms/ folder yet is completely
   * normal (this feature is opt-in, not every workspace uses it). Returns
   * per-file errors (bad export shape, a throw during require()) instead
   * of throwing, matching how EndpointRegistry.reloadFromDisk() reports a
   * bad config file: one broken function shouldn't prevent every other
   * function (or the whole server) from loading. */
  loadFromDisk(): { errors: FunctionLoadError[] } {
    const errors: FunctionLoadError[] = [];
    const next = new Map<string, TransformFunction>();

    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".js"));
    } catch {
      this.functions = next;
      return { errors };
    }

    for (const file of files) {
      const name = path.basename(file, ".js");
      const fullPath = path.join(this.dir, file);
      try {
        const mod = requireExact(fullPath);
        const fn = typeof mod === "function" ? mod : (mod as { default?: unknown })?.default;
        if (typeof fn !== "function") {
          errors.push({ file, error: "module does not export a function (expected module.exports = transform;)" });
          continue;
        }
        next.set(name, fn as TransformFunction);
      } catch (err) {
        errors.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.functions = next;
    return { errors };
  }

  /** Dev-only: re-requires a single function by name, bypassing Node's
   * module cache -- see this class's own doc comment above for why this
   * must never be reachable from QA/Production. Throws (rather than
   * swallowing the error) if the file is missing or doesn't export
   * correctly, since the Console surfaces this directly to the developer
   * who just saved it, instead of silently keeping the previous version
   * live. */
  reloadOne(name: string): void {
    const fullPath = path.join(this.dir, `${name}.js`);
    const mod = requireExact(fullPath);
    const fn = typeof mod === "function" ? mod : (mod as { default?: unknown })?.default;
    if (typeof fn !== "function") {
      throw new Error(`${name}.js does not export a function (expected module.exports = transform;)`);
    }
    this.functions.set(name, fn as TransformFunction);
  }

  /** Dev-only: drops a function from the live registry, e.g. after its
   * backing file is deleted via the Console (see consoleApi.ts's DELETE
   * /functions/:name). */
  remove(name: string): void {
    this.functions.delete(name);
  }

  get(name: string): TransformFunction | undefined {
    return this.functions.get(name);
  }

  has(name: string): boolean {
    return this.functions.has(name);
  }

  list(): string[] {
    return [...this.functions.keys()].sort();
  }
}
