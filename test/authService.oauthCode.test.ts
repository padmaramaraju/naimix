import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/authService";
import { InMemorySessionStore } from "../src/auth/sessionStore";
import type { AuthProvidersRegistry } from "../src/server/authProvidersRegistry";
import type { AuthProvidersFileParsed } from "../src/config/schema";
import type { AuthResult } from "../src/auth/types";

/**
 * Covers AuthService.completeOAuthLogin() -- the Authorization Code
 * callback's counterpart to login(), added by pulling the "mint an opaque
 * token, store the session" bookkeeping out of login() into a shared
 * createSession() both paths now call (see authService.ts and
 * oauthCodeFlow.ts). The important thing to prove: a session created via
 * completeOAuthLogin() is indistinguishable, from resolveSession()'s point
 * of view, from one created via the ordinary login() path -- and login()
 * itself still works unchanged after the refactor.
 */

vi.mock("../src/auth/providerFactory", () => ({
  createAuthProvider: vi.fn(() => ({
    name: "demoLogin",
    kind: "basicLogin",
    login: vi.fn(async () => ({ backendToken: "tok-1", expiresAt: Date.now() + 60_000 }) satisfies AuthResult),
  })),
}));

function fakeRegistry(authProviders: AuthProvidersFileParsed["authProviders"]): AuthProvidersRegistry {
  return { getResolved: () => ({ authProviders }) } as unknown as AuthProvidersRegistry;
}

describe("AuthService.completeOAuthLogin", () => {
  it("creates a session resolvable the same way a login()-created one is", async () => {
    const registry = fakeRegistry({});
    const service = new AuthService(registry, new InMemorySessionStore());

    const result: AuthResult = {
      backendToken: "backend-token-abc",
      refreshToken: "refresh-abc",
      expiresAt: Date.now() + 60_000,
      subject: "demo-user",
      claims: { role: "admin" },
    };

    const { token, expiresAt } = await service.completeOAuthLogin("demoOAuthCode", result);
    expect(token).toBeTruthy();
    expect(expiresAt).toBe(result.expiresAt);

    const session = await service.resolveSession(token, "demoOAuthCode");
    expect(session).toMatchObject({
      providerName: "demoOAuthCode",
      backendToken: "backend-token-abc",
      refreshToken: "refresh-abc",
      subject: "demo-user",
      claims: { role: "admin" },
    });
  });

  it("rejects a token against the wrong provider name, same as an ordinary login session would", async () => {
    const registry = fakeRegistry({});
    const service = new AuthService(registry, new InMemorySessionStore());
    const { token } = await service.completeOAuthLogin("demoOAuthCode", { backendToken: "t" });

    await expect(service.resolveSession(token, "someOtherProvider")).rejects.toThrow(/issued by auth provider/);
  });

  it("login() still produces a resolvable session after the createSession() refactor (real login() path, provider mocked)", async () => {
    const registry = fakeRegistry({
      demoLogin: {
        kind: "basicLogin",
        loginUrl: "http://localhost:0/login",
        tokenPath: "$.accessToken",
      } as AuthProvidersFileParsed["authProviders"][string],
    });
    const service = new AuthService(registry, new InMemorySessionStore());

    const { token, expiresAt } = await service.login("demoLogin", { username: "demo", password: "demo123" });
    expect(expiresAt).toBeGreaterThan(Date.now());
    const session = await service.resolveSession(token, "demoLogin");
    expect(session.backendToken).toBe("tok-1");
  });
});
