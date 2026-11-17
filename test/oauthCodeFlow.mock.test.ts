import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pino from "pino";
import yaml from "js-yaml";
import { startMockOAuthServer, type MockIssuerHandle, type MockOAuthServerHandle, type Scenario } from "../src/mock-backend/oauthServer";
import { AuthProvidersRegistry } from "../src/server/authProvidersRegistry";
import { AuthService } from "../src/auth/authService";
import { InMemorySessionStore } from "../src/auth/sessionStore";
import { InMemoryOAuthPendingFlowStore } from "../src/auth/oauthPendingFlowStore";
import { createAuthRouter } from "../src/server/authRoutes";

/**
 * Flow-level tests for the Authorization Code login: naimix's real
 * createAuthRouter + AuthService + pending-flow store, run against the mock
 * provider (src/mock-backend/oauthServer.ts) over real HTTP. The test plays
 * the browser: /start -> follow the redirect to the mock's /authorize ->
 * follow its redirect back to naimix's /callback.
 *
 * Two groups:
 * - "current behavior" pins down what is built today and passes.
 * - "planned changes" is the test-first half of AUTH_DESIGN_NOTES.md's
 *   "Authorization Code: what's built, plus planned changes". Those tests
 *   FAIL until the matching change is implemented -- that is the point.
 *
 * Provider configs already carry the planned fields (`jwksUri`, and `pkce`
 * on one provider). The config schema is non-strict, so today they are
 * silently ignored; they make the planned tests exercise behavior instead
 * of failing on config loading.
 */

const NAIMIX = "http://naimix.test"; // never listened on; the test routes callbacks itself
const RETURN_TO = "https://app.test/done";
const APP = "webapp";
const CLIENT_ID = "naimix";
const CLIENT_SECRET = "naimix-secret";

const PROVIDERS = [
  { name: "idpA", pkce: "required" as const },
  { name: "idpB", pkce: "required" as const },
  { name: "idpIss", pkce: "required" as const, issParameter: true },
  // A provider that doesn't require PKCE, configured on the naimix side with `pkce: off` (planned).
  { name: "idpNoPkce", pkce: "optional" as const, extra: { pkce: "off" } },
];

let mock: MockOAuthServerHandle;
const idp: Record<string, MockIssuerHandle> = {};
let tmpDir: string;
let app: Express;
let authService: AuthService;
let sessionStore: InMemorySessionStore;
let pendingStore: InMemoryOAuthPendingFlowStore;

beforeAll(async () => {
  mock = await startMockOAuthServer();
  const authProviders: Record<string, unknown> = {};
  for (const p of PROVIDERS) {
    const callback = `${NAIMIX}/auth/oauth/${p.name}/callback`;
    const issuer = mock.addIssuer(p.name, {
      issParameter: p.issParameter,
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [callback], pkce: p.pkce }],
    });
    idp[p.name] = issuer;
    authProviders[p.name] = {
      kind: "oauth2",
      grantType: "authorizationCode",
      tokenUrl: issuer.tokenEndpoint,
      authorizationUrl: issuer.authorizationEndpoint,
      issuer: issuer.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: "openid offline_access",
      redirectUri: callback,
      jwksUri: issuer.jwksUri, // planned field; ignored until signature checking exists
      clients: [{ id: APP, returnTo: [RETURN_TO] }],
      ...(p.extra ?? {}),
    };
  }

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-oauthflow-"));
  const file = path.join(tmpDir, "authProviders.yaml");
  fs.writeFileSync(file, yaml.dump({ authProviders }));
  const registry = new AuthProvidersRegistry(file);

  sessionStore = new InMemorySessionStore();
  pendingStore = new InMemoryOAuthPendingFlowStore();
  authService = new AuthService(registry, sessionStore);
  app = express();
  app.use("/auth", createAuthRouter(authService, registry, pendingStore, pino({ level: "silent" })));
});

afterAll(async () => {
  await mock.stop();
  sessionStore.stop();
  pendingStore.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mock.clearRequests();
  for (const issuer of Object.values(idp)) issuer.reset();
});

// ---- the "browser" -------------------------------------------------------

interface Trace {
  start: request.Response;
  authorize?: { status: number; location?: URL };
  callback?: request.Response;
  /** Where the callback sent the browser: the calling app's return_to. */
  redirect?: URL;
  /** The fragment of that redirect (token, error, state ...). */
  fragment: URLSearchParams;
}

async function browserLogin(provider: string, opts: { app?: string; returnTo?: string; appState?: string } = {}): Promise<Trace> {
  const start = await request(app)
    .get(`/auth/oauth/${provider}/start`)
    .query({ app: opts.app ?? APP, return_to: opts.returnTo ?? RETURN_TO, state: opts.appState ?? "app-state-1" });
  const trace: Trace = { start, fragment: new URLSearchParams() };
  if (start.status !== 302) return trace;

  const res = await fetch(start.headers.location, { redirect: "manual" });
  const location = res.headers.get("location");
  trace.authorize = { status: res.status, location: location ? new URL(location) : undefined };
  if (!trace.authorize.location) return trace;

  const back = trace.authorize.location;
  trace.callback = await request(app).get(back.pathname + back.search);
  const next = trace.callback.headers.location;
  if (next) {
    trace.redirect = new URL(next);
    trace.fragment = new URLSearchParams(trace.redirect.hash.replace(/^#/, ""));
  }
  return trace;
}

const sessionCount = async () => (await authService.listSessions()).length;

/** A login that must end with the browser sent back to the app with an error, no token, and no session. */
async function expectRejected(provider: string, scenario: Scenario, opts: { appState?: string } = {}): Promise<Trace> {
  idp[provider].nextLogin(scenario);
  const before = await sessionCount();
  const trace = await browserLogin(provider, opts);
  expect(trace.callback?.status, "the callback should redirect back to the app").toBe(302);
  expect(trace.fragment.get("token"), "no token may be issued").toBeNull();
  expect(trace.fragment.has("error"), "an error code is expected").toBe(true);
  expect(await sessionCount(), "no session may be created").toBe(before);
  return trace;
}

const callbackSearchOf = (trace: Trace) => trace.authorize!.location!.search;

// ---------------------------------------------------------------------------
// Current behavior (passes today)
// ---------------------------------------------------------------------------

describe("current behavior: a successful login", () => {
  it("hands the app its own session token, its own state, and the expiry", async () => {
    const trace = await browserLogin("idpA", { appState: "keep-me" });
    expect(trace.redirect!.origin + trace.redirect!.pathname).toBe(RETURN_TO);
    expect(trace.fragment.get("token")).toMatch(/^[0-9a-f]{64}$/);
    expect(trace.fragment.get("state")).toBe("keep-me");
    expect(Number(trace.fragment.get("expires_at"))).toBeGreaterThan(Date.now());
    expect(trace.fragment.has("error")).toBe(false);
  });

  it("creates a session holding the provider's tokens, never the provider's tokens in the fragment", async () => {
    const trace = await browserLogin("idpA");
    const token = trace.fragment.get("token")!;
    const session = await authService.resolveSession(token, "idpA");
    expect(session.backendToken).toMatch(/^mock-access-/);
    expect(session.refreshToken).toMatch(/^mock-refresh-/);
    expect(session.subject).toBe("mock-user-1");
    expect(trace.redirect!.hash).not.toContain("mock-access");
    expect(trace.redirect!.hash).not.toContain("mock-refresh");
  });

  it("refuses to use the session on a different provider", async () => {
    const token = (await browserLogin("idpA")).fragment.get("token")!;
    await expect(authService.resolveSession(token, "idpB")).rejects.toThrow(/issued by auth provider "idpA"/);
  });

  it("refreshes a code-flow session through the standard refresh_token grant, rotating the refresh token", async () => {
    const token = (await browserLogin("idpA")).fragment.get("token")!;
    const first = await authService.resolveSession(token, "idpA");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3_600_000 + 60_000);
      const refreshed = await authService.resolveSession(token, "idpA");
      expect(refreshed.backendToken).not.toBe(first.backendToken);
      expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("current behavior: what naimix sends", () => {
  it("sends the authorization request with S256 PKCE, state, scope and the exact redirect_uri", async () => {
    await browserLogin("idpA");
    const [req] = mock.requestsFor("idpA", "authorize");
    expect(req.query).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${NAIMIX}/auth/oauth/idpA/callback`,
      scope: "openid offline_access",
      code_challenge_method: "S256",
    });
    expect(req.query.code_challenge).toBeTruthy();
    expect(req.query.state).toBeTruthy();
    expect(req.query.state).not.toBe("app-state-1"); // naimix's own state, not the app's
  });

  it("exchanges the code with the matching verifier, the same redirect_uri, and client_secret_post", async () => {
    await browserLogin("idpA");
    const [authorizeReq] = mock.requestsFor("idpA", "authorize");
    const [tokenReq] = mock.requestsFor("idpA", "token");
    expect(tokenReq.clientAuth).toBe("post");
    expect(tokenReq.body).toMatchObject({ grant_type: "authorization_code", redirect_uri: `${NAIMIX}/auth/oauth/idpA/callback` });
    const challenge = crypto.createHash("sha256").update(tokenReq.body.code_verifier).digest("base64url");
    expect(challenge).toBe(authorizeReq.query.code_challenge);
  });

  it("sends an explicit S256 as the default method (the per-provider option's default)", async () => {
    await browserLogin("idpB");
    expect(mock.requestsFor("idpB", "authorize")[0].query.code_challenge_method).toBe("S256");
  });
});

describe("current behavior: /start", () => {
  it("rejects an unknown provider, missing parameters, and an unregistered app or return_to", async () => {
    const unknown = await request(app).get("/auth/oauth/nope/start").query({ app: APP, return_to: RETURN_TO });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("InvalidProvider");

    const missing = await request(app).get("/auth/oauth/idpA/start").query({ app: APP });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("InvalidRequest");

    const badApp = await request(app).get("/auth/oauth/idpA/start").query({ app: "ghost", return_to: RETURN_TO });
    expect(badApp.status).toBe(400);
    expect(badApp.body.error).toBe("UnregisteredClient");

    const badReturn = await request(app).get("/auth/oauth/idpA/start").query({ app: APP, return_to: "https://evil.test/steal" });
    expect(badReturn.status).toBe(400);
    expect(badReturn.body.error).toBe("UnregisteredClient");
    expect(mock.requestsFor("idpA", "authorize")).toHaveLength(0);
  });
});

describe("current behavior: /callback state handling", () => {
  it("answers a missing, unknown or already-used state with a plain 400, never a redirect", async () => {
    const missing = await request(app).get("/auth/oauth/idpA/callback?code=x");
    expect(missing.status).toBe(400);
    expect(missing.headers.location).toBeUndefined();

    const unknown = await request(app).get("/auth/oauth/idpA/callback?code=x&state=never-issued");
    expect(unknown.status).toBe(400);
    expect(unknown.headers.location).toBeUndefined();

    const trace = await browserLogin("idpA");
    const replay = await request(app).get(`/auth/oauth/idpA/callback${callbackSearchOf(trace)}`);
    expect(replay.status).toBe(400);
    expect(replay.headers.location).toBeUndefined();
  });

  it("rejects a callback for a different provider than the one the flow started on, and creates no session", async () => {
    const start = await request(app).get("/auth/oauth/idpA/start").query({ app: APP, return_to: RETURN_TO });
    const authorize = await fetch(start.headers.location, { redirect: "manual" });
    const back = new URL(authorize.headers.get("location")!);
    const before = await sessionCount();
    const res = await request(app).get(`/auth/oauth/idpB/callback${back.search}`);
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(await sessionCount()).toBe(before);
  });
});

describe("current behavior: failures go back to the app", () => {
  it("passes a provider's access_denied back to return_to with the app's own state", async () => {
    idp.idpA.nextLogin({ authorize: { error: "access_denied", errorDescription: "user said no" } });
    const trace = await browserLogin("idpA", { appState: "keep-me" });
    expect(trace.fragment.get("error")).toBe("access_denied");
    expect(trace.fragment.get("state")).toBe("keep-me");
    expect(trace.fragment.get("token")).toBeNull();
  });

  it("rejects a failed code exchange (5xx, OAuth error, malformed body) with an error and no session", async () => {
    await expectRejected("idpA", { token: { status: 500 } });
    await expectRejected("idpA", { token: { error: "invalid_grant" } });
    await expectRejected("idpA", { token: { body: "<html>not json</html>" } });
  });

  it("rejects an ID token with a wrong issuer, a wrong audience, or an expiry in the past", async () => {
    await expectRejected("idpA", { idToken: { claims: { iss: "https://evil.test" } } });
    await expectRejected("idpA", { idToken: { claims: { aud: "someone-else" } } });
    await expectRejected("idpA", { idToken: { expiresInSeconds: -300 } });
  });

  it("rejects an ID token issued by another provider's issuer (mix-up)", async () => {
    await expectRejected("idpA", { idToken: { claims: { iss: idp.idpB.issuer } } });
  });

  it("still returns the app's own state with every error", async () => {
    const trace = await expectRejected("idpA", { idToken: { claims: { aud: "someone-else" } } }, { appState: "keep-me" });
    expect(trace.fragment.get("state")).toBe("keep-me");
  });
});

// Found by running the planned tests: the OIDC library behind oauthCodeFlow.ts
// already enforces these, some for a different reason than the planned design
// gives. They stay as guards for after the planned changes land.
describe("current behavior: checks the OIDC library already enforces", () => {
  it("rejects an ID token with no sub", async () => {
    await expectRejected("idpA", { idToken: { claims: { sub: undefined } } });
  });

  // The library requires the ID token's alg header to be RS256. It checks the
  // header, not the signature: see the signature tests under "planned".
  it("rejects an unsigned (alg none) ID token", async () => {
    await expectRejected("idpA", { idToken: { alg: "none" } });
  });

  it("rejects an HS256 ID token signed with the public key (algorithm confusion)", async () => {
    await expectRejected("idpA", { idToken: { alg: "HS256-public-key" } });
  });

  // Today the library rejects any nonce claim when none was requested. Once
  // naimix sends a nonce, this same test becomes the mismatch check.
  it("rejects an ID token whose nonce is not the one naimix sent", async () => {
    await expectRejected("idpA", { idToken: { claims: { nonce: "someone-elses" } } });
  });

  it("rejects an authorization response whose iss parameter is not the provider's issuer (RFC 9207)", async () => {
    await expectRejected("idpIss", { authorize: { iss: "https://evil.test" } });
  });

  // Passes today only because no signature is verified. It guards the refetch
  // behavior once verification exists: a key rotated in after naimix cached
  // the JWKS must be picked up, not rejected.
  it("accepts an ID token signed by a key rotated in after an earlier login", async () => {
    expect((await browserLogin("idpA")).fragment.get("token")).not.toBeNull();
    idp.idpA.rotateKeys();
    const trace = await browserLogin("idpA");
    expect(trace.fragment.get("token"), "a rotated-in key must be accepted").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Planned changes (FAIL until implemented)
// ---------------------------------------------------------------------------

describe("planned: nonce", () => {
  it("sends a nonce with the authorization request", async () => {
    await browserLogin("idpA");
    expect(mock.requestsFor("idpA", "authorize")[0].query.nonce, "naimix should send a nonce").toBeTruthy();
  });

  it("rejects an ID token with no nonce claim", async () => {
    await expectRejected("idpA", { idToken: { claims: { nonce: undefined } } });
  });
});

describe("planned: ID token required and complete", () => {
  it("rejects a token response with no id_token when the openid scope was requested", async () => {
    await expectRejected("idpA", { token: { omitIdToken: true } });
  });

  it("rejects an ID token issued in the future, beyond the clock tolerance", async () => {
    await expectRejected("idpA", { idToken: { issuedAtOffsetSeconds: 600 } });
  });
});

describe("planned: signature verification", () => {
  it("rejects an ID token signed by a key that is not in the JWKS", async () => {
    await expectRejected("idpA", { idToken: { signWith: "unknown" } });
  });

  it("rejects an ID token whose payload was changed after signing", async () => {
    await expectRejected("idpA", { idToken: { tamperPayload: { sub: "admin" } } });
  });

});

describe("planned: per-provider PKCE option", () => {
  it("sends no code_challenge and no code_verifier for a provider configured with pkce: off", async () => {
    const trace = await browserLogin("idpNoPkce");
    expect(trace.fragment.get("token"), "the login itself should still succeed").not.toBeNull();
    expect(mock.requestsFor("idpNoPkce", "authorize")[0].query.code_challenge, "no challenge when pkce is off").toBeUndefined();
    expect(mock.requestsFor("idpNoPkce", "token")[0].body.code_verifier, "no verifier when pkce is off").toBeUndefined();
  });
});

describe("planned: failures use a fixed set of codes and carry no detail", () => {
  it("passes a provider error back as access_denied without its error_description", async () => {
    const trace = await expectRejected("idpA", { authorize: { error: "access_denied", errorDescription: "user said no" } });
    expect(trace.fragment.get("error")).toBe("access_denied");
    expect(trace.fragment.has("error_description"), "no detail may reach the app").toBe(false);
  });

  it("reports every ID token validation failure as invalid_id_token, with no detail", async () => {
    const trace = await expectRejected("idpA", { idToken: { claims: { aud: "someone-else" } } });
    expect(trace.fragment.get("error")).toBe("invalid_id_token");
    expect(trace.fragment.has("error_description"), "no detail may reach the app").toBe(false);
  });

  it("reports a token endpoint 5xx as provider_unavailable, with no detail", async () => {
    const trace = await expectRejected("idpA", { token: { status: 500 } });
    expect(trace.fragment.get("error")).toBe("provider_unavailable");
    expect(trace.fragment.has("error_description"), "no detail may reach the app").toBe(false);
  });

  it("reports a malformed token response as provider_unavailable, with no detail", async () => {
    const trace = await expectRejected("idpA", { token: { body: "<html>not json</html>" } });
    expect(trace.fragment.get("error")).toBe("provider_unavailable");
    expect(trace.fragment.has("error_description"), "no detail may reach the app").toBe(false);
  });
});

describe("open decisions", () => {
  it.todo("a callback sent to the wrong provider should not consume the legitimate pending flow (currently it does; decide first)");
  it.todo("a JWKS endpoint that is down: which error code, and does the login fail or retry (not yet decided)");
});
