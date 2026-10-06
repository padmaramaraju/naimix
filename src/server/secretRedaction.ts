// Shared "hide secrets from the console API, but let leaving a field blank on
// edit mean 'keep the stored value'" convention, used by both
// GatewaysRegistry and AuthProvidersRegistry (gateway connection secrets and
// OAuth client secrets have the exact same shape of problem).

/** Field names treated as sensitive: redacted in API responses, and an
 * empty submitted value means "leave the stored value unchanged" rather
 * than "clear it". Matched case-insensitively against object keys. */
export const SENSITIVE_KEY_PATTERN = /pass|secret|token|apikey|api_key|credential/i;

export const REDACTED = "••••••••";

/** Container keys whose children are plain substitution values, never
 * secrets, regardless of what the child's own key happens to be named. A
 * gateway's `commonParams` are {name} substitution values made available
 * to every endpoint that uses the gateway (see schema.ts's
 * commonParamsField) -- not credentials this codebase stores, even if
 * someone names one of them "apiToken" or similar. Checked against the
 * immediate parent key, same as SENSITIVE_KEY_PATTERN is checked against
 * a field's own key. */
const NON_SENSITIVE_CONTAINER_KEYS = new Set(["commonParams"]);

/** A field ending in "Path" is, by this codebase's own convention, a
 * JSONPath expression (e.g. an auth provider's tokenPath/refreshTokenPath),
 * never a literal secret value -- even though its name contains "token"
 * and would otherwise match SENSITIVE_KEY_PATTERN. Excluded so it's neither
 * redacted nor treated as "blank means unchanged". */
function isSensitiveKey(keyHint: string): boolean {
  if (!keyHint || keyHint.endsWith("Path")) return false;
  return SENSITIVE_KEY_PATTERN.test(keyHint);
}

/** Masks only the given keys of a flat string record -- the opt-in
 * counterpart to the name-pattern-based `redact()` above, used for a
 * gateway's commonParams (see commonParamsMasked in schema.ts/config.ts):
 * masking there is a setting the person configuring the gateway turns on
 * per entry, never something inferred from an entry's own name. An
 * ${env.X} reference is shown as-is either way, same as every other
 * field -- the variable name isn't the secret. */
export function redactSelected(
  obj: Record<string, string> | undefined,
  maskedKeys: readonly string[] | undefined
): Record<string, string> | undefined {
  if (!obj) return obj;
  const masked = new Set(maskedKeys ?? []);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = masked.has(k) && !v.startsWith("${env.") ? REDACTED : v;
  }
  return out;
}

/** The commonParams-specific counterpart to `mergeUnchangedSecrets()`:
 * an empty value submitted for a key in `maskedKeys` keeps the previously
 * stored value (so a masked field left blank in the UI means "unchanged",
 * matching the convention every other secret field already follows) --
 * for any key NOT in `maskedKeys`, an empty value really does clear it. */
export function mergeSelectedUnchanged(
  input: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
  maskedKeys: readonly string[] | undefined
): Record<string, string> | undefined {
  if (!input) return input;
  const masked = new Set(maskedKeys ?? []);
  const prevObj = previous ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v === "" && masked.has(k) && typeof prevObj[k] === "string" ? prevObj[k] : v;
  }
  return out;
}

export function redact(value: unknown, keyHint = ""): unknown {
  if (typeof value === "string") {
    if (value.startsWith("${env.")) return value; // env references are safe to show as-is
    return isSensitiveKey(keyHint) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const skipChildRedaction = NON_SENSITIVE_CONTAINER_KEYS.has(keyHint);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = skipChildRedaction ? v : redact(v, k);
    }
    return out;
  }
  return value;
}

/** Recursively replaces an empty-string leaf at a sensitive key with the
 * previous value at the same path, so leaving a password/secret field blank
 * in the UI means "unchanged" rather than "set to empty". Children of a
 * NON_SENSITIVE_CONTAINER_KEYS container (e.g. commonParams) are never
 * sensitive, so submitting an empty value for one of them clears it like
 * any ordinary field, rather than being merged back to its previous value. */
export function mergeUnchangedSecrets(input: unknown, previous: unknown, keyHint = ""): unknown {
  if (typeof input === "string") {
    if (input === "" && isSensitiveKey(keyHint) && typeof previous === "string") {
      return previous;
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((v, i) => mergeUnchangedSecrets(v, Array.isArray(previous) ? previous[i] : undefined));
  }
  if (input && typeof input === "object") {
    const prevObj = previous && typeof previous === "object" ? (previous as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    const skipChildMerge = NON_SENSITIVE_CONTAINER_KEYS.has(keyHint);
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = skipChildMerge ? v : mergeUnchangedSecrets(v, prevObj[k], k);
    }
    return out;
  }
  return input;
}
