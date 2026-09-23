// See AUTH_DESIGN_NOTES.md for the design behind this file.

/** What a successful login (or refresh) against a real auth provider
 * yields: the token to store server-side and hand to backends on the
 * caller's behalf, plus whatever else the provider captured. */
export interface AuthResult {
  backendToken: string;
  refreshToken?: string;
  /** Absolute expiry, epoch ms. Undefined means "no known expiry" -- the
   * session is treated as valid indefinitely (until logout). */
  expiresAt?: number;
  subject?: string;
  claims?: Record<string, unknown>;
}

/** One provider kind's implementation -- parallel to how callBackend()
 * dispatches to a connector per backend type. `refresh` is optional:
 * providers that can't refresh (e.g. a bespoke login API with no refresh
 * token) simply mean an expired session gets a clean 401 asking the caller
 * to log in again, rather than automatic renewal. */
export interface AuthProvider {
  readonly name: string;
  readonly kind: string;
  login(credentials: Record<string, unknown>): Promise<AuthResult>;
  refresh?(session: SessionRecord): Promise<AuthResult>;
}

/** What's stored server-side, keyed by the opaque token handed to the
 * caller. Deliberately never sent to the caller -- see the opaque-vs-JWT
 * decision in AUTH_DESIGN_NOTES.md. */
export interface SessionRecord {
  providerName: string;
  backendToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subject?: string;
  claims?: Record<string, unknown>;
  createdAt: number;
}
