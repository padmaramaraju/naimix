import { describe, expect, it } from "vitest";
import { compileFunctionSource, runInSandbox } from "../src/server/functionCompiler";
import { ValidationError } from "../src/server/errors";

/**
 * Covers the Developer Console's save/test pipeline for custom transform
 * functions -- see TRANSFORM_FUNCTIONS_DESIGN_NOTES.md. compileFunctionSource
 * is the ONLY place esbuild ever runs (never at request time, never in
 * QA/Production -- see its own doc comment); runInSandbox is the ONLY
 * place untrusted-while-being-written code ever executes, and only here,
 * never for an already-saved function (which is just a normal require()'d
 * module by the time anything else touches it -- see FunctionRegistry).
 */
describe("compileFunctionSource", () => {
  it("compiles a plain-JS `transform` function to a CommonJS module that exports it", () => {
    const compiled = compileFunctionSource("function transform(v) { return v + 1; }");
    expect(compiled).toContain("module.exports = transform;");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fn = new Function("module", "exports", compiled + "\nreturn module.exports;")({ exports: {} }, {});
    expect(fn(1)).toBe(2);
  });

  it("compiles TypeScript syntax (type annotations stripped), not just plain JS", () => {
    const compiled = compileFunctionSource("function transform(v: number): number { return v * 2; }");
    const fn = new Function("module", "exports", compiled + "\nreturn module.exports;")({ exports: {} }, {});
    expect(fn(3)).toBe(6);
  });

  it("throws a ValidationError (not a raw esbuild error) on invalid syntax", () => {
    expect(() => compileFunctionSource("function transform(v) { return v +")).toThrow(ValidationError);
  });
});

describe("runInSandbox", () => {
  it("calls the compiled function with (value, ctx) and returns its result", () => {
    const compiled = compileFunctionSource("function transform(v, ctx) { return v + (ctx.params?.n || 0); }");
    const res = runInSandbox(compiled, 5, { params: { n: 10 } });
    expect(res).toEqual({ ok: true, result: 15, logs: [] });
  });

  it("captures console.log calls into `logs` instead of the real process stdout", () => {
    const compiled = compileFunctionSource('function transform(v) { console.log("saw", v); return v; }');
    const res = runInSandbox(compiled, "x", {});
    expect(res.ok).toBe(true);
    expect(res.logs).toEqual(['saw x']);
  });

  it("a thrown error inside the function comes back as ok:false with the error message, not an uncaught exception", () => {
    const compiled = compileFunctionSource('function transform() { throw new Error("boom"); }');
    const res = runInSandbox(compiled, null, {});
    expect(res).toEqual({ ok: false, error: "boom", logs: [] });
  });

  it("an infinite loop is stopped by the timeout rather than hanging forever", () => {
    const compiled = compileFunctionSource("function transform() { while (true) {} }");
    const res = runInSandbox(compiled, null, {}, 50);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out|timeout/i);
  }, 2000);

  it("has no access to `process`, `require`, or other Node globals -- referencing one throws inside the sandbox rather than reaching the real process", () => {
    const compiled = compileFunctionSource("function transform() { return process.env; }");
    const res = runInSandbox(compiled, null, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/process/);
  });
});
