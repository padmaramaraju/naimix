import crypto from "node:crypto";
import type { AuthProvidersRegistry } from "../server/authProvidersRegistry";
import { AuthError, ValidationError } from "../server/errors";
import { createAuthProvider } from "./providerFactory";
import type { SessionStore } from "./sessionStore";
import type { SessionRecord } from "./types";

// Refresh a little before expiry rather than waiting for the backend to
// reject an about-to-expire token -- see "Refresh token handling" in
// AUTH_DESIGN_NOTES.md.
const REFRESH_MARGIN_MS = 30_000;

/** What the admin UI's session viewer gets for each active session. Outside
 * production (see `isDevMode()` below), this also carries the real session
 * token and the backend/refresh token it wraps, for local debugging -- e.g.
 * copying a token to replay a call by hand. In production those three
 * fields are always omitted, matching the "don't re-display a secret once
 * it exists" stance the codebase already takes for gateway/provider
 * secrets: never ship this over the wire against a real directory/backend.
 * `id` identifies the session for revoking it (see AuthService.
 * revokeSession) in every environment, dev or production alike, without
 * itself being the bearer token. */
export interface SessionSummary {
  id: string;
  providerName: string;
  subject?: string;
  claims?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  hasRefreshToken: boolean;
  /** Dev-only (see `isDevMode()`): the real bearer token a caller would send
   * as `Authorization: Bearer <token>`. Always undefined in production. */
  token?: string;
  /** Dev-only: the real token this middleware injects into backend calls on
   * the caller's behalf. Always undefined in production. */
  backendToken?: string;
  /** Dev-only: the provider's refresh token for this session, if any.
   * Always undefined in production. */
  refreshToken?: string;
}

/** A non-reversible stand-in for a session token, safe to show in the admin
 * UI and to accept back from it for revocation: knowing this id doesn't let
 * anyone reconstruct or replay the real bearer token it's derived from. */
function sessionId(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Gates the dev-only fields on SessionSummary (and the /admin/api/meta
 * `devMode` flag the admin UI reads to decide whether to render them).
 * Same "opt out of the sensitive behavior only in production" convention
 * `logger.ts` already uses for pretty- vs JSON-printing -- unset/anything
 * other than exactly "production" is treated as a non-production
 * environment, so this is on by default for local development and for the
 * test suite, and only ever off once NODE_ENV is explicitly "production". */
function isDevMode(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Ties together the configured auth providers and the session store: login/
 * logout, and resolving a caller's opaque session token back to the real
 * backend token a request needs, refreshing it first if it's due. This is
 * the one thing dispatch.ts and the /auth routes both depend on -- neither
 * talks to a provider or the session store directly.
 */
export class AuthService {
  // In-process de-duplication so N near-simultaneous requests for the same
  // about-to-expire session trigger exactly one refresh call, not N of them
  // (especially important with rotating refresh tokens). Single-instance
  // only, matching the in-memory session store this phase ships with -- a
  // multi-instance deployment needs a distributed version of this same
  // idea (see "Concurrent-refresh stampede" in AUTH_DESIGN_NOTES.md).
  private refreshInFlight = new Map<string, Promise<SessionRecord>>();

  constructor(
    private providers: AuthProvidersRegistry,
    private store: SessionStore
  ) {}

  async login(providerName: string, credentials: Record<string, unknown>): Promise<{ token: string; expiresAt?: number }> {
    const provider = this.getProvider(providerName);
    const result = await provider.login(credentials);

    const token = crypto.randomBytes(32).toString("hex");
    const record: SessionRecord = {
      providerName,
      backendToken: result.backendToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      subject: result.subject,
      claims: result.claims,
      createdAt: Date.now(),
    };
    await this.store.set(token, record);
    return { token, expiresAt: record.expiresAt };
  }

  async logout(token: string): Promise<void> {
    await this.store.delete(token);
  }

  /** Every session currently held in memory -- for the admin UI's "what's
   * actually stored" view (see AUTH_DESIGN_NOTES.md's opaque-token design:
   * this in-memory store is the only place a backend token or refresh
   * token ever lives). Outside production (see `isDevMode()`), this is a
   * deliberate exception to that opaque-token design for local debugging --
   * it includes the real session token and the backend/refresh token it
   * wraps. In production those three are always omitted; every environment
   * still gets enough to identify each session (provider, subject, claims,
   * timestamps) and revoke it by `id`. */
  async listSessions(): Promise<SessionSummary[]> {
    const all = await this.store.list();
    const devMode = isDevMode();
    return all.map(({ token, record }) => ({
      id: sessionId(token),
      providerName: record.providerName,
      subject: record.subject,
      claims: record.claims,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      hasRefreshToken: Boolean(record.refreshToken),
      ...(devMode ? { token, backendToken: record.backendToken, refreshToken: record.refreshToken } : {}),
    }));
  }

  /** Revokes one session by the opaque `id` listSessions() handed out
   * (never the real token, which the admin UI never sees). Returns false
   * if no currently-held session matches -- e.g. it already expired and
   * was swept, or was already revoked. */
  async revokeSession(id: string): Promise<boolean> {
    const all = await this.store.list();
    const match = all.find(({ token }) => sessionId(token) === id);
    if (!match) return false;
    await this.store.delete(match.token);
    return true;
  }

  /**
   * Looks up the session for `token`, requires it to have been issued by
   * `requiredProvider` (a gateway's `requiresAuth` names exactly one
   * provider -- a token from a different one isn't valid for it, even if
   * both are otherwise live sessions), and refreshes it first if it's due.
   * Throws AuthError for anything that should reach the caller as a 401.
   */
  async resolveSession(token: string, requiredProvider: string): Promise<SessionRecord> {
    const record = await this.store.get(token);
    if (!record) {
      throw new AuthError("Invalid or expired session token");
    }
    if (record.providerName !== requiredProvider) {
      throw new AuthError(
        `This session token was issued by auth provider "${record.providerName}", but this endpoint's gateway requires "${requiredProvider}"`
      );
    }
    return this.ensureFresh(token, record);
  }

  private getProvider(name: string) {
    const config = this.providers.getResolved().authProviders[name];
    if (!config) {
      throw new ValidationError(`Unknown auth provider "${name}"`);
    }
    return createAuthProvider(name, config);
  }

  private needsRefresh(record: SessionRecord): boolean {
    return record.expiresAt !== undefined && Date.now() >= record.expiresAt - REFRESH_MARGIN_MS;
  }

  private isExpired(record: SessionRecord): boolean {
    return record.expiresAt !== undefined && Date.now() >= record.expiresAt;
  }

  private async ensureFresh(token: string, record: SessionRecord): Promise<SessionRecord> {
    if (!this.needsRefresh(record)) return record;

    const inFlight = this.refreshInFlight.get(token);
    if (inFlight) return inFlight;

    const promise = this.doRefresh(token, record).finally(() => {
      this.refreshInFlight.delete(token);
    });
    this.refreshInFlight.set(token, promise);
    return promise;
  }

  private async doRefresh(token: string, record: SessionRecord): Promise<SessionRecord> {
    const provider = this.getProvider(record.providerName);

    if (!provider.refresh) {
      if (this.isExpired(record)) {
        await this.store.delete(token);
        throw new AuthError("Session has expired; please log in again");
      }
      // Not refreshable, but not expired yet either -- proceed with what
      // we have rather than failing a request early over a provider that
      // was never going to renew it anyway.
      return record;
    }

    try {
      const result = await provider.refresh(record);
      const updated: SessionRecord = {
        ...record,
        backendToken: result.backendToken,
        // Some providers rotate the refresh token on every use; others
        // (or a client_credentials grant with nothing to rotate) don't
        // return one at all, in which case keep the one we had.
        refreshToken: result.refreshToken ?? record.refreshToken,
        expiresAt: result.expiresAt,
        claims: result.claims ?? record.claims,
      };
      await this.store.set(token, updated);
      return updated;
    } catch (err) {
      if (this.isExpired(record)) {
        await this.store.delete(token);
        throw new AuthError("Session refresh failed and the session has expired; please log in again");
      }
      // The proactive refresh attempt failed (clock skew, a transient
      // backend error) but the existing token is technically still valid
      // for a little longer -- let this request through on it rather than
      // failing over an early refresh that didn't strictly need to succeed
      // yet. The next request past REFRESH_MARGIN_MS will try again.
      return record;
    }
  }
}
