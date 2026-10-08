import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FunctionRegistry } from "../src/transform/functionRegistry";
import { EndpointRegistry } from "../src/server/endpointRegistry";
import { ValidationError } from "../src/server/errors";

/**
 * Covers FunctionRegistry itself (loadFromDisk/reloadOne/remove -- see its
 * own doc comment in src/transform/functionRegistry.ts for the two very
 * different lifecycles these back: QA/Production's one-time boot load
 * vs. the Developer Console's save-then-hot-reload) and the validation
 * endpointRegistry.ts layers on top: a config referencing an unknown
 * function name is a load/save error, the same "bad reference, not a
 * silent no-op" rule a bad gateway name already gets -- see
 * functionRefs.ts.
 */

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-function-registry-test-"));
const TRANSFORMS_DIR = path.join(TMP_DIR, "transforms");

function writeFn(name: string, body: string): void {
  fs.mkdirSync(TRANSFORMS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TRANSFORMS_DIR, `${name}.js`), `module.exports = ${body};\n`, "utf8");
}

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("FunctionRegistry", () => {
  it("loading a nonexistent transforms/ directory is a no-op, not an error -- a brand-new workspace with none yet is normal", () => {
    const registry = new FunctionRegistry(path.join(TMP_DIR, "does-not-exist"));
    const { errors } = registry.loadFromDisk();
    expect(errors).toHaveLength(0);
    expect(registry.list()).toEqual([]);
  });

  it("loads every *.js file's default export, keyed by basename", () => {
    writeFn("upper", "function (v) { return String(v).toUpperCase(); }");
    writeFn("addOne", "function (v) { return v + 1; }");
    const registry = new FunctionRegistry(TRANSFORMS_DIR);
    const { errors } = registry.loadFromDisk();
    expect(errors).toHaveLength(0);
    expect(registry.list()).toEqual(["addOne", "upper"]);
    expect(registry.get("upper")?.("hi", {})).toBe("HI");
    expect(registry.get("addOne")?.(2, {})).toBe(3);
  });

  it("reports a per-file error (and doesn't register it) when a file's export isn't a function, without failing the whole load", () => {
    writeFn("good", "function (v) { return v; }");
    fs.writeFileSync(path.join(TRANSFORMS_DIR, "bad.js"), "module.exports = { not: \"a function\" };\n", "utf8");
    const registry = new FunctionRegistry(TRANSFORMS_DIR);
    const { errors } = registry.loadFromDisk();
    expect(errors).toEqual([{ file: "bad.js", error: expect.stringContaining("does not export a function") }]);
    expect(registry.has("good")).toBe(true);
    expect(registry.has("bad")).toBe(false);
    fs.unlinkSync(path.join(TRANSFORMS_DIR, "bad.js"));
  });

  it("reloadOne() picks up an edit to an already-loaded function without constructing a new registry (bypasses require's module cache)", () => {
    writeFn("greet", "function (name) { return \"hello \" + name; }");
    const registry = new FunctionRegistry(TRANSFORMS_DIR);
    registry.loadFromDisk();
    expect(registry.get("greet")?.("Ada", {})).toBe("hello Ada");

    writeFn("greet", "function (name) { return \"hi \" + name; }");
    registry.reloadOne("greet");
    expect(registry.get("greet")?.("Ada", {})).toBe("hi Ada");
  });

  it("remove() drops a function from the live registry", () => {
    writeFn("temp", "function (v) { return v; }");
    const registry = new FunctionRegistry(TRANSFORMS_DIR);
    registry.loadFromDisk();
    expect(registry.has("temp")).toBe(true);
    registry.remove("temp");
    expect(registry.has("temp")).toBe(false);
  });

  /**
   * Regression coverage for a real bug a user hit under `npm run dev`
   * (tsx): with a `<name>.ts` source and `<name>.js` compiled file sitting
   * side by side -- exactly the pairing the Console's own save flow
   * creates on purpose (see consoleApi.ts's PUT /functions/:name) --
   * require()'s module resolution silently substituted the `.ts` sibling
   * for the requested `.js` path. That `.ts` source is just the author's
   * bare function declaration with no `module.exports` of its own, so the
   * substitution loaded the WRONG file and a perfectly good compiled
   * function looked like it "doesn't export a function". The fix
   * (requireExact() in functionRegistry.ts) builds the CommonJS module
   * directly from the known-exact `.js` path's own content instead of
   * asking require() to go find it, so no resolver -- tsx's or
   * otherwise -- gets a chance to substitute a different file. This test
   * can't reproduce the tsx-specific resolution quirk itself (it runs
   * under plain Node/vitest, which never substituted anything -- that's
   * exactly why it took a live diagnostic in the real dev server to catch
   * in the first place), but it does prove the fix's actual guarantee:
   * loading `<name>.js` always reads `<name>.js`'s own content, regardless
   * of what a same-named `.ts` sibling contains.
   */
  it("loads the .js file's own export even when a same-named .ts sibling exists with no module.exports at all", () => {
    writeFn("categoryPath", "function (data) { return data; }");
    // The .ts "source" sibling a real Console save also writes -- a bare
    // function declaration, deliberately with NO module.exports, same
    // shape as what the Console editor's textarea holds before compiling.
    fs.writeFileSync(
      path.join(TRANSFORMS_DIR, "categoryPath.ts"),
      "function transform(data, ctx) {
  return data;
}
",
      "utf8"
    );
    const registry = new FunctionRegistry(TRANSFORMS_DIR);
    const { errors } = registry.loadFromDisk();
    expect(errors).toHaveLength(0);
    expect(registry.has("categoryPath")).toBe(true);
    expect(registry.get("categoryPath")?.("value", {})).toBe("value");
    fs.unlinkSync(path.join(TRANSFORMS_DIR, "categoryPath.ts"));
  });
});

describe("EndpointRegistry: validates custom-function references against a FunctionRegistry", () => {
  const ENDPOINTS_DIR = path.join(TMP_DIR, "endpoints");

  function endpointConfig(overrides: Record<string, unknown> = {}) {
    return {
      id: "fn-ref-test",
      method: "GET",
      path: "/api/fn-ref-test",
      backend: { type: "json", url: "http://example.invalid/x" },
      output: { fields: [{ target: "id", source: "$.id" }] },
      ...overrides,
    };
  }

  beforeEach(() => {
    fs.rmSync(ENDPOINTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(ENDPOINTS_DIR, { recursive: true });
  });

  it("reloadFromDisk() reports a load error (and skips the endpoint) when its transform references an unregistered function", () => {
    fs.writeFileSync(
      path.join(ENDPOINTS_DIR, "fn-ref-test.yaml"),
      JSON.stringify(
        endpointConfig({
          output: {
            fields: [{ target: "x", source: "$.x", transform: { kind: "function", name: "doesNotExist" } }],
          },
        })
      ),
      "utf8"
    );
    const functionRegistry = new FunctionRegistry(path.join(TMP_DIR, "empty-transforms"));
    functionRegistry.loadFromDisk();
    const endpointRegistry = new EndpointRegistry(ENDPOINTS_DIR, functionRegistry);
    const { errors } = endpointRegistry.reloadFromDisk();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("doesNotExist");
    expect(endpointRegistry.list()).toHaveLength(0);
  });

  it("reloadFromDisk() loads the endpoint fine once the referenced function IS registered", () => {
    writeFn("known", "function (v) { return v; }");
    fs.writeFileSync(
      path.join(ENDPOINTS_DIR, "fn-ref-test.yaml"),
      JSON.stringify(
        endpointConfig({
          output: { fields: [{ target: "x", source: "$.x", transform: { kind: "function", name: "known" } }] },
        })
      ),
      "utf8"
    );
    const functionRegistry = new FunctionRegistry(TRANSFORMS_DIR);
    functionRegistry.loadFromDisk();
    const endpointRegistry = new EndpointRegistry(ENDPOINTS_DIR, functionRegistry);
    const { errors } = endpointRegistry.reloadFromDisk();
    expect(errors).toHaveLength(0);
    expect(endpointRegistry.list()).toHaveLength(1);
  });

  it("upsert() throws a ValidationError immediately when saving a config that references an unknown function, rather than writing a broken file", () => {
    const functionRegistry = new FunctionRegistry(path.join(TMP_DIR, "empty-transforms"));
    functionRegistry.loadFromDisk();
    const endpointRegistry = new EndpointRegistry(ENDPOINTS_DIR, functionRegistry);
    expect(() =>
      endpointRegistry.upsert(
        endpointConfig({
          output: {
            fields: [{ target: "x", source: "$.x", transform: { kind: "function", name: "stillMissing" } }],
          },
        })
      )
    ).toThrow(ValidationError);
    expect(fs.readdirSync(ENDPOINTS_DIR)).toHaveLength(0);
  });

  it("a config with no function references at all validates fine with NO FunctionRegistry configured", () => {
    fs.writeFileSync(path.join(ENDPOINTS_DIR, "fn-ref-test.yaml"), JSON.stringify(endpointConfig()), "utf8");
    const endpointRegistry = new EndpointRegistry(ENDPOINTS_DIR); // no second arg -- matches every pre-existing caller
    const { errors } = endpointRegistry.reloadFromDisk();
    expect(errors).toHaveLength(0);
    expect(endpointRegistry.list()).toHaveLength(1);
  });
});
