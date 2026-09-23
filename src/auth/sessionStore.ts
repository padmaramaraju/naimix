import type { SessionRecord } from "./types";

/**
 * Where sessions (and, later, whatever else needs cross-instance sharing --
 * the refresh lock, OAuth pending-flow state) actually live. `InMemoryStore`
 * below is the only implementation in this phase; a Redis-backed one can be
 * dropped in later behind this exact interface without touching AuthService
 * or anything upstream of it -- see "Multi-instance / load balancing" in
 * AUTH_DESIGN_NOTES.md.
 */
export interface SessionStore {
  get(token: string): Promise<SessionRecord | undefined>;
  set(token: string, record: SessionRecord): Promise<void>;
  delete(token: string): Promise<void>;
  /** Every currently-held session, token included -- used only by
   * AuthService's admin-facing session listing/revocation (see
   * listSessions()/revokeSession() in authService.ts), which derives a
   * non-reversible id from each token rather than ever handing the real
   * token back out. A future Redis-backed store implements this with a
   * SCAN over its own keyspace. */
  list(): Promise<Array<{ token: string; record: SessionRecord }>>;
}

/**
 * Default, single-process session store. Fine for one local dev instance;
 * not shared across instances, so it does NOT survive a restart and does
 * NOT work behind a load balancer with more than one instance -- that's
 * exactly the gap a future Redis-backed SessionStore closes, per
 * AUTH_DESIGN_NOTES.md's "Multi-instance / load balancing" section.
 *
 * Dead sessions (past expiry with no refresh token, so they can never
 * become valid again) are swept periodically so they don't accumulate in
 * memory forever on a long-running process.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private sweepTimer: NodeJS.Timeout;

  constructor(sweepIntervalMs = 5 * 60 * 1000) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async get(token: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(token);
  }

  async set(token: string, record: SessionRecord): Promise<void> {
    this.sessions.set(token, record);
  }

  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async list(): Promise<Array<{ token: string; record: SessionRecord }>> {
    return [...this.sessions.entries()].map(([token, record]) => ({ token, record }));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, record] of this.sessions) {
      if (record.expiresAt !== undefined && now >= record.expiresAt && !record.refreshToken) {
        this.sessions.delete(token);
      }
    }
  }

  /** Stops the periodic sweep timer -- call on process/test shutdown so it
   * doesn't keep a handle open. */
  stop(): void {
    clearInterval(this.sweepTimer);
  }
}
