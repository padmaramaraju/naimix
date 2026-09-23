import { JSONPath } from "jsonpath-plus";
import type { FieldTransform, OutputConfig, OutputFieldDef } from "../types/config";

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

function applyTransform(value: unknown, transform?: FieldTransform): unknown {
  if (value === undefined || value === null || !transform) return value;
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
 * shape as an endpoint's output.fields. */
export function mapItem(item: unknown, fields: OutputFieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    let value = extractJsonPath(item, field.source);
    if (value === undefined) {
      value = field.default;
    } else {
      value = applyTransform(value, field.transform);
    }
    if (value !== undefined) {
      setDeep(out, field.target, value);
    }
  }
  return out;
}

/**
 * Applies a declarative output config to a raw backend response.
 * - If `output.root` is set, it's a JSONPath selecting an array of items;
 *   each item is mapped independently and the result is a JSON array.
 * - Otherwise the whole response is mapped once into a single JSON object.
 */
export function mapResponse(response: unknown, output: OutputConfig): unknown {
  if (output.root) {
    const items = JSONPath({ path: output.root, json: response as object, wrap: true }) as unknown[];
    return items.map((item) => mapItem(item, output.fields));
  }
  return mapItem(response, output.fields);
}
