// Shared "hide secrets from the admin API, but let leaving a field blank on
// edit mean 'keep the stored value'" convention, used by both
// GatewaysRegistry and AuthProvidersRegistry (gateway connection secrets and
// OAuth client secrets have the exact same shape of problem).

/** Field names treated as sensitive: redacted in API responses, and an
 * empty submitted value means "leave the stored value unchanged" rather
 * than "clear it". Matched case-insensitively against object keys. */
export const SENSITIVE_KEY_PATTERN = /pass|secret|token|apikey|api_key|credential/i;

export const REDACTED = "••••••••";

/** A field ending in "Path" is, by this codebase's own convention, a
 * JSONPath expression (e.g. an auth provider's tokenPath/refreshTokenPath),
 * never a literal secret value -- even though its name contains "token"
 * and would otherwise match SENSITIVE_KEY_PATTERN. Excluded so it's neither
 * redacted nor treated as "blank means unchanged". */
function isSensitiveKey(keyHint: string): boolean {
  if (!keyHint || keyHint.endsWith("Path")) return false;
  return SENSITIVE_KEY_PATTERN.test(keyHint);
}

export function redact(value: unknown, keyHint = ""): unknown {
  if (typeof value === "string") {
    if (value.startsWith("${env.")) return value; // env references are safe to show as-is
    return isSensitiveKey(keyHint) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

/** Recursively replaces an empty-string leaf at a sensitive key with the
 * previous value at the same path, so leaving a password/secret field blank
 * in the UI means "unchanged" rather than "set to empty". */
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
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = mergeUnchangedSecrets(v, prevObj[k], k);
    }
    return out;
  }
  return input;
}
