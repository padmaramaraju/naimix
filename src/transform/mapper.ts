import { JSONPath } from "jsonpath-plus";
import type { OutputConfig, OutputFieldDef, OutputTransform } from "../types/config";
import type { FunctionRegistry } from "./functionRegistry";

/** Threaded through mapItem()/mapResponse() to resolve a `kind: "function"`
 * transform/postProcess reference (see OutputTransform/OutputConfig.postProcess
 * in src/types/config.ts). Optional and defaults to nothing resolvable --
 * every existing call site (auth providers' `claims` mapItem() calls,
 * every pre-existing test) keeps working unchanged, since a config with no
 * function references never looks at `functions` at all. `params` is the
 * endpoint's resolved input params for this request, passed through to a
 * custom function's `ctx` for the (quite real) case where a transform
 * wants to know the caller's own input, not just the backend response. */
export interface MapperOptions {
  functions?: FunctionRegistry;
  params?: Record<string, unknown>;
}

/** Splits "name.first" or "tags[0].label" into ["name","first"] / ["tags","0","label"] */
function splitTargetPath(target: string): string[] {
  return target
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((seg) => seg.length > 0);
}

function setDeep(obj: Record<string, unknown>, target: string, value: unknown): void {
  const segments = splitTargetPath(target);
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const nextSegIsIndex = /^\d+$/.test(segments[i + 1]);
    if (cursor[seg] === undefined || typeof cursor[seg] !== "object" || cursor[seg] === null) {
      cursor[seg] = nextSegIsIndex ? [] : {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

function applyTransform(
  value: unknown,
  transform: OutputTransform | undefined,
  ctx: { item: unknown; raw: unknown; params?: Record<string, unknown> },
  functions?: FunctionRegistry
): unknown {
  if (value === undefined || value === null || !transform) return value;

  if (typeof transform === "object") {
    // kind: "function" -- see FunctionTransformRef in src/types/config.ts.
    const fn = functions?.get(transform.name);
    if (!fn) {
      throw new Error(
        `Custom transform function "${transform.name}" is not available` +
          (functions ? "" : " (no function registry was configured)")
      );
    }
    return fn(value, ctx);
  }

  switch (transform) {
    case "toString":
      return String(value);
    case "toNumber": {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case "toBoolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return ["true", "1", "yes"].includes(value.toLowerCase());
      return Boolean(value);
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value;
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value;
    default:
      return value;
  }
}

/** Evaluates a single JSONPath expression against `json`, returning the
 * first match (or undefined). Exported for reuse anywhere else that needs
 * the same "pull one field out of an arbitrary JSON response" primitive --
 * e.g. src/auth/providers/basicLogin.ts, extracting a token/expiry/subject
 * out of a login response using the same engine as endpoint output.fields. */
export function extractJsonPath(json: unknown, source: string): unknown {
  const matches = JSONPath({ path: source, json: json as object, wrap: true }) as unknown[];
  return matches.length > 0 ? matches[0] : undefined;
}

/** Applies a list of OutputFieldDef extractions to a single JSON value,
 * producing one plain object. Exported for reuse by the auth providers'
 * `claims` extraction (see src/types/config.ts), which uses the identical
 * shape as an endpoint's output.fields.
 *
 * An OutputArrayFieldDef ("kind: array") field is handled by recursing:
 * its `root` is evaluated against this same `item` (the same per-item
 * context every sibling value field's `source` is evaluated against), and
 * each match is itself mapped through the array field's own `fields` --
 * which may contain further array fields, to any depth. This is what lets
 * an endpoint's output hold more than one array, and arrays nested inside
 * arrays (e.g. customers[].orders[]). */
export function mapItem(
  item: unknown,
  fields: OutputFieldDef[],
  opts: MapperOptions = {},
  raw: unknown = item
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ctx = { item, raw, params: opts.params };
  for (const field of fields) {
    if (field.kind === "array") {
      const subItems = JSONPath({ path: field.root, json: item as object, wrap: true }) as unknown[];
      setDeep(
        out,
        field.target,
        subItems.map((subItem) => mapItem(subItem, field.fields, opts, raw))
      );
      continue;
    }
    let value = extractJsonPath(item, field.source);
    if (value === undefined) {
      value = field.default;
    } else {
      value = applyTransform(value, field.transform, ctx, opts.functions);
    }
    if (value !== undefined) {
      setDeep(out, field.target, value);
    }
  }
  return out;
}

/**
 * Applies a declarative output config to a raw backend response, mapping
 * it once into a single JSON object via `output.fields` -- every
 * `source`/nested-array `root` in those fields is evaluated relative to
 * this same real, unscoped response (see OutputArrayFieldDef's doc
 * comment in src/types/config.ts). A field that itself needs to produce
 * a JSON array uses an OutputArrayFieldDef ("kind: array") like any other
 * field, the same mechanism at any depth -- there's no separate top-level
 * construct for "the response as a whole is an array": that field is just
 * named like any other, e.g. `{ items: [...] }` rather than a bare `[...]`.
 */
export function mapResponse(response: unknown, output: OutputConfig, opts: MapperOptions = {}): unknown {
  let result: unknown = mapItem(response, output.fields, opts, response);

  if (output.postProcess) {
    const fn = opts.functions?.get(output.postProcess.name);
    if (!fn) {
      throw new Error(
        `Custom post-process function "${output.postProcess.name}" is not available` +
          (opts.functions ? "" : " (no function registry was configured)")
      );
    }
    result = fn(result, { raw: response, params: opts.params });
  }

  return result;
}

