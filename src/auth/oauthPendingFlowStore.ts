/**
 * Short-lived state for an in-flight Authorization Code redirect, keyed by
 * our own internal `state` value (see oauthCodeFlow.ts) -- the PKCE verifier
 * plus everything needed to validate and complete the callback once the
 * real provider redirects back. See AUTH_DESIGN_NOTES.md's "Surviving the
 * round trip": `/start` and `/callback` are two separate HTTP requests, so
 * this has to live somewhere both can reach -- exactly the same "needs a
 * shared store" shape sessions already have (see sessionStore.ts).
 *
 * `InMemoryOAuthPendingFlowStore` below is the only implementation for now,
 * same single-instance/dev-only limitation InMemorySessionStore already
 * carries: it does NOT survive a restart and does NOT work behind a load
 * balancer with more than one instance, since `/start` and the matching
 * `/callback` are near-certain to land on different instances there. A
 * future Redis-backed store closes this gap for sessions and this pending
 * state together, as one feature (see "Multi-instance / load balancing" in
 * AUTH_DESIGN_NOTES.md) -- deliberately not built ahead of actual need here.
 */
export interface PendingOAuthFlow {
  /** Name of the auth provider this flow is logging in against. */
  providerName: string;
  /** PKCE code_verifier generated at /start, sent to the token endpoint at
   * /callback alongside the authorization code. */
  codeVerifier: string;
  /** The registered client app's own id, from /start's `app` param --
   * re-validated at /callback time in case the provider config changed
   * mid-flow (e.g. the app was removed from `clients` after /start ran). */
  appClientId: string;
  /** Exact return_to this flow will redirect back to once the callback
   * completes -- captured at /start, never re-read from the callback
   * request, so nothing about the callback request itself can redirect
   * anywhere other than what /start already validated. */
  returnTo: string;
  /** The calling app's own opaque pass-through value from /start (if any),
   * handed back unchanged alongside our token so the app can correlate
   * this response with the request that started it. Not used by naimix
   * for anything else -- in particular, NOT the same value as the internal
   * `state` this flow is keyed by. */
  appState?: string;
  createdAt: number;
}

export interface OAuthPendingFlowStore {
  get(state: string): Promise<PendingOAuthFlow | undefined>;
  set(state: string, flow: PendingOAuthFlow): Promise<void>;
  /** Single-use: /callback deletes a flow as soon as it reads it, win or
   * lose, so a replayed callback request (same `state` twice) can't
   * complete the exchange a second time. */
  delete(state: string): Promise<void>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Default, single-process pending-flow store. See the interface doc comment
 * above for the multi-instance limitation this shares with
 * InMemorySessionStore.
 *
 * Expired-but-never-collected entries (a /start that never got a matching
 * /callback -- the user abandoned the login, or closed the tab) are swept
 * periodically so they don't accumulate in memory forever on a long-running
 * process, same convention InMemorySessionStore already uses for dead
 * sessions.
 */
export class InMemoryOAuthPendingFlowStore implements OAuthPendingFlowStore {
  private flows = new Map<string, PendingOAuthFlow>();
  private sweepTimer: NodeJS.Timeout;

  constructor(
    private ttlMs = DEFAULT_TTL_MS,
    sweepIntervalMs = 60 * 1000
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async get(state: string): Promise<PendingOAuthFlow | undefined> {
    const flow = this.flows.get(state);
    if (!flow) return undefined;
    if (Date.now() - flow.createdAt > this.ttlMs) {
      this.flows.delete(state);
      return undefined;
    }
    return flow;
  }

  async set(state: string, flow: PendingOAuthFlow): Promise<void> {
    this.flows.set(state, flow);
  }

  async delete(state: string): Promise<void> {
    this.flows.delete(state);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (now - flow.createdAt > this.ttlMs) {
        this.flows.delete(state);
      }
    }
  }

  /** Stops the periodic sweep timer -- call on process/test shutdown so it
   * doesn't keep a handle open. */
  stop(): void {
    clearInterval(this.sweepTimer);
  }
}
