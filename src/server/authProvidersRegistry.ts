import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { authProvidersFileSchema, authProviderConfigSchema, type AuthProvidersFileParsed } from "../config/schema";
import { loadAuthProvidersRaw } from "../config/loader";
import { substituteEnv } from "../config/envSubst";
import { createAuthProvider } from "../auth/providerFactory";
import { ValidationError } from "./errors";
import { redact, mergeUnchangedSecrets } from "./secretRedaction";

export interface TestLoginResult {
  ok: boolean;
  message?: string;
  subject?: string;
  claims?: Record<string, unknown>;
  expiresAt?: number;
}

/**
 * Holds the current set of named auth providers in memory, backed by
 * authProviders.yaml on disk -- the auth-provider counterpart to
 * GatewaysRegistry, following the exact same conventions (raw vs.
 * ${env.X}-resolved views, redaction of secret-looking fields, "blank field
 * on edit means unchanged"). See AUTH_DESIGN_NOTES.md.
 *
 * Unlike GatewaysRegistry, validation failures here get zod's own field
 * errors for free: authProviderConfigSchema is a true discriminated union
 * (kind is required on every branch), so there's no need for the
 * branch-picking workaround gatewaysRegistry.ts's parseGatewayConfig does
 * for its own union (where kind is optional on most branches).
 */
export class AuthProvidersRegistry {
  private raw: AuthProvidersFileParsed;

  constructor(private filePath: string) {
    this.raw = loadAuthProvidersRaw(filePath);
  }

  getFilePath(): string {
    return this.filePath;
  }

  setFilePath(filePath: string): void {
    this.filePath = filePath;
    this.reloadFromDisk();
  }

  reloadFromDisk(): void {
    this.raw = loadAuthProvidersRaw(this.filePath);
  }

  /** Raw (unsubstituted) providers, as edited/persisted -- for a future admin UI. */
  listRaw(): AuthProvidersFileParsed["authProviders"] {
    return this.raw.authProviders;
  }

  getRaw(name: string): unknown {
    return this.raw.authProviders[name];
  }

  /** Same shape, with sensitive-looking literal fields (e.g. clientSecret) masked. */
  listRedacted(): AuthProvidersFileParsed["authProviders"] {
    const out: AuthProvidersFileParsed["authProviders"] = {};
    for (const [name, provider] of Object.entries(this.raw.authProviders)) {
      out[name] = redact(provider) as (typeof this.raw.authProviders)[string];
    }
    return out;
  }

  /** ${env.X}-resolved providers -- what AuthService actually logs callers in with. */
  getResolved(): AuthProvidersFileParsed {
    return authProvidersFileSchema.parse(substituteEnv(this.raw));
  }

  /**
   * Creates or updates a named auth provider. For fields matching
   * SENSITIVE_KEY_PATTERN (e.g. clientSecret), submitting an empty string
   * keeps the previously stored value.
   */
  upsert(name: string, input: unknown): void {
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new ValidationError("Auth provider name must contain only letters, digits, _ or -");
    }
    const existing = this.raw.authProviders[name];
    const merged = mergeUnchangedSecrets(input, existing);
    const parsed = authProviderConfigSchema.parse(merged);

    this.raw = { authProviders: { ...this.raw.authProviders, [name]: parsed } };
    // Fail fast if this makes an env reference point at an unset variable.
    authProvidersFileSchema.parse(substituteEnv(this.raw));
    this.persist();
  }

  /**
   * Attempts a real login against a provider's config -- either an already-
   * saved one (`name` given) or a draft still being edited in the admin UI
   * (`name` omitted) -- without creating a session, so it's safe to use
   * while iterating on a provider's settings. The auth-provider counterpart
   * to GatewaysRegistry.testConnection(): `name` (optional) lets an
   * in-progress edit reuse the previously stored value for any sensitive
   * field (bindPassword, clientSecret, tokenSecret, ...) the draft left
   * blank, same as saving would.
   *
   * A malformed config (missing/invalid fields) is allowed to throw --
   * adminApi.ts's existing zod-error middleware turns that into the same
   * 400 response saving would give. Only a real login attempt failing (bad
   * credentials, an unreachable directory/server, a rejected search) comes
   * back as `{ ok: false, message }` for the UI to show inline, and the
   * resulting backend token is deliberately never included in the result --
   * only enough (subject/claims/expiry) to confirm the config actually
   * authenticates.
   */
  async testLogin(name: string | undefined, input: unknown, credentials: Record<string, unknown>): Promise<TestLoginResult> {
    const existing = name ? this.raw.authProviders[name] : undefined;
    const merged = mergeUnchangedSecrets(input, existing);
    const parsed = authProviderConfigSchema.parse(merged);

    let resolved: typeof parsed;
    try {
      resolved = authProviderConfigSchema.parse(substituteEnv(parsed));
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed to resolve a ${env.*} reference in this config" };
    }

    const provider = createAuthProvider(name ?? "(test)", resolved);
    try {
      const result = await provider.login(credentials);
      return { ok: true, subject: result.subject, claims: result.claims, expiresAt: result.expiresAt };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Login failed" };
    }
  }

  remove(name: string): boolean {
    if (!(name in this.raw.authProviders)) return false;
    const { [name]: _removed, ...rest } = this.raw.authProviders;
    this.raw = { authProviders: rest };
    this.persist();
    return true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, yaml.dump(this.raw, { lineWidth: 100, noRefs: true }), "utf8");
  }
}
