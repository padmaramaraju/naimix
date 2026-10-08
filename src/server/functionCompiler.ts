import vm from "node:vm";
import * as esbuild from "esbuild";
import { ValidationError } from "./errors";

/**
 * Compiles a custom transform function's source (TypeScript or plain
 * JavaScript -- the Console editor accepts either) into the plain
 * CommonJS this project's FunctionRegistry actually require()s at
 * runtime. The author's code must declare a top-level `transform`
 * identifier (a `function transform(data, ctx) { ... }` or `const
 * transform = (data, ctx) => { ... }`); everything else they write above
 * it (helper functions, constants) is free-form, since this only appends
 * one line (`module.exports = transform;`) after their code rather than
 * wrapping it. The same compiled shape is used whether the function will
 * end up referenced from a field's `transform` or an endpoint's
 * `postProcess` -- see FunctionTransformRef's doc comment in
 * src/types/config.ts for why there's deliberately no separate "field
 * function" vs "endpoint function" concept.
 *
 * esbuild only ever runs here, inside consoleApi.ts's dev-only save/test
 * routes -- never at request time in dispatch.ts, and never in the
 * QA/Production build (consoleApi.ts is structurally absent from both,
 * see scripts/checkDataPlaneBundle.js), so esbuild being a devDependency
 * rather than a runtime one is exactly right: it only needs to be
 * resolvable while `npm run dev`'s own node_modules (which includes
 * devDependencies) is what's running.
 */
export function compileFunctionSource(code: string): string {
  let result: esbuild.TransformResult;
  try {
    result = esbuild.transformSync(code, {
      loader: "ts",
      format: "cjs",
      target: "node24",
      sourcefile: "transform.ts",
    });
  } catch (err) {
    const message =
      err && typeof err === "object" && "errors" in err
        ? (err as { errors: { text: string }[] }).errors.map((e) => e.text).join("; ")
        : err instanceof Error
          ? err.message
          : String(err);
    throw new ValidationError(`Could not compile function source: ${message}`);
  }
  return `${result.code}\nmodule.exports = transform;\n`;
}

export interface SandboxRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
}

/**
 * Runs ALREADY-COMPILED (see compileFunctionSource above) function code in
 * a fresh, deliberately bare vm.Context -- no `require`, `process`, `fs`,
 * `fetch`, or any other Node global, only the handful of built-ins we
 * explicitly seed below (console, for feedback; Object/Array/JSON/etc.
 * come from V8 itself and need nothing added). A hard `timeout` bounds how
 * long synchronous execution is allowed to run, so a stray infinite loop
 * in a function someone is actively testing can't hang the dev server --
 * see TRANSFORM_FUNCTIONS_DESIGN_NOTES.md's "Dev Console -- dynamic, for
 * iteration speed" for why this sandbox exists at all: this is the ONLY
 * place untrusted-while-being-written code ever runs. Once saved, the
 * compiled .js is just a normal, fully-trusted required module, same as
 * any other file in the registry (see FunctionRegistry) -- no sandbox
 * involved there at all.
 */
export function runInSandbox(
  compiledCode: string,
  value: unknown,
  ctx: { item?: unknown; raw?: unknown; params?: Record<string, unknown> },
  timeoutMs = 200
): SandboxRunResult {
  const logs: string[] = [];
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map(safeStringify).join(" ")),
    warn: (...args: unknown[]) => logs.push("[warn] " + args.map(safeStringify).join(" ")),
    error: (...args: unknown[]) => logs.push("[error] " + args.map(safeStringify).join(" ")),
  };

  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    console: sandboxConsole,
    __VALUE__: value,
    __CTX__: ctx,
  };
  const context = vm.createContext(sandbox);

  try {
    const script = new vm.Script(`${compiledCode}\nmodule.exports(__VALUE__, __CTX__)`, {
      filename: "transform.js",
    });
    const result = script.runInContext(context, { timeout: timeoutMs });
    return { ok: true, result, logs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), logs };
  }
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
