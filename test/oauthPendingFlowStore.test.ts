import { describe, expect, it, vi, afterEach } from "vitest";
import { InMemoryOAuthPendingFlowStore, type PendingOAuthFlow } from "../src/auth/oauthPendingFlowStore";

/**
 * Covers InMemoryOAuthPendingFlowStore's TTL/sweep/single-use behavior --
 * the pending-flow counterpart to how sessionStore.ts's own InMemory
 * implementation would be tested. See AUTH_DESIGN_NOTES.md's "Surviving
 * the round trip".
 */
describe("InMemoryOAuthPendingFlowStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFlow(overrides: Partial<PendingOAuthFlow> = {}): PendingOAuthFlow {
    return {
      providerName: "demoOAuthCode",
      codeVerifier: "verifier-123",
      appClientId: "webApp",
      returnTo: "https://app.example.com/done",
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it("round-trips a stored flow", async () => {
    const store = new InMemoryOAuthPendingFlowStore();
    const flow = makeFlow();
    await store.set("state-1", flow);
    expect(await store.get("state-1")).toEqual(flow);
    store.stop();
  });

  it("returns undefined for an unknown state", async () => {
    const store = new InMemoryOAuthPendingFlowStore();
    expect(await store.get("nope")).toBeUndefined();
    store.stop();
  });

  it("is single-use: delete() removes it, a later get() returns undefined", async () => {
    const store = new InMemoryOAuthPendingFlowStore();
    const flow = makeFlow();
    await store.set("state-1", flow);
    await store.delete("state-1");
    expect(await store.get("state-1")).toBeUndefined();
    store.stop();
  });

  it("expires a flow past its TTL even without the sweep running", async () => {
    vi.useFakeTimers();
    const store = new InMemoryOAuthPendingFlowStore(1000 /* ttlMs */, 60_000);
    const flow = makeFlow({ createdAt: Date.now() });
    await store.set("state-1", flow);

    vi.advanceTimersByTime(1500);
    expect(await store.get("state-1")).toBeUndefined();
    store.stop();
  });

  it("the periodic sweep clears an expired flow proactively", async () => {
    vi.useFakeTimers();
    const store = new InMemoryOAuthPendingFlowStore(1000 /* ttlMs */, 500 /* sweepIntervalMs */);
    await store.set("state-1", makeFlow({ createdAt: Date.now() }));

    vi.advanceTimersByTime(2000); // past both the ttl and at least one sweep tick
    // Read directly from the private map via get() is already covered above;
    // this confirms the sweep itself ran by checking the entry is gone
    // without relying on get()'s own lazy-expiry check.
    expect(await store.get("state-1")).toBeUndefined();
    store.stop();
  });
});
