// Resolves ${env.VAR_NAME} placeholders anywhere inside a parsed config
// value (recursively, over strings/objects/arrays), against process.env.
// This runs once at config-load time, so secrets never need to be hard-coded
// into endpoint/gateway files.

const ENV_PLACEHOLDER = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function substituteEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    return value.replace(ENV_PLACEHOLDER, (match, varName) => {
      const resolved = env[varName];
      if (resolved === undefined) {
        throw new Error(
          `Config references \${env.${varName}} but that environment variable is not set.`
        );
      }
      return resolved;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnv(item, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnv(v, env);
    }
    return out as unknown as T;
  }
  return value;
}
