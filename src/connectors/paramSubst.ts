// Resolves {paramName} placeholders inside backend config values (URLs,
// headers, query values, SOAP args, XML body templates) against the input
// parameters extracted from an incoming request. Runs per-request.

export type ResolvedParams = Record<string, string | number | boolean>;

const PARAM_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function substituteParams<T>(value: T, params: ResolvedParams): T {
  if (typeof value === "string") {
    return value.replace(PARAM_PLACEHOLDER, (match, name) => {
      if (!(name in params)) {
        // Leave unresolved placeholders as-is; the caller may intentionally
        // reference a param that wasn't required for this endpoint.
        return match;
      }
      return String(params[name]);
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteParams(item, params)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteParams(v, params);
    }
    return out as unknown as T;
  }
  return value;
}
