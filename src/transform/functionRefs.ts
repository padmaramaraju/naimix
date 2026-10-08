import type { OutputConfig, OutputFieldDef } from "../types/config";
import type { FunctionRegistry } from "./functionRegistry";

/** Every custom-function name referenced anywhere in an output config --
 * a field's `transform: { kind: "function", name }` at any nesting depth
 * (including inside OutputArrayFieldDef's own nested `fields`) plus the
 * endpoint-level `postProcess.name`, if set. Shared by endpointRegistry.ts
 * (validating a config references only functions the FunctionRegistry
 * actually has -- the same "a bad reference is a load/save error" rule a
 * bad gateway name already gets) and consoleApi.ts's DELETE
 * /functions/:name (finding which endpoints depend on a function before
 * deleting it, the same "409 Conflict with dependents" shape
 * DELETE /gateways/:name already uses). */
export function collectFunctionNames(output: OutputConfig): string[] {
  const names = new Set<string>();

  function walk(fields: OutputFieldDef[]): void {
    for (const field of fields) {
      if (field.kind === "array") {
        walk(field.fields);
        continue;
      }
      if (field.transform && typeof field.transform === "object" && field.transform.kind === "function") {
        names.add(field.transform.name);
      }
    }
  }
  walk(output.fields);

  if (output.postProcess) {
    names.add(output.postProcess.name);
  }

  return [...names];
}

/** Names referenced by `output` that aren't in `functions` -- empty when
 * every reference resolves (including when `output` references none at
 * all, the overwhelmingly common case today). */
export function missingFunctionNames(output: OutputConfig, functions: FunctionRegistry | undefined): string[] {
  return collectFunctionNames(output).filter((name) => !functions?.has(name));
}
