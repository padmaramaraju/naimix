import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  startMockOAuthServer,
  type MockIssuerHandle,
  type MockOAuthServerHandle,
} from "../src/mock-backend/oauthServer";

/**
 * Self-tests for the mock OAuth/OIDC provider (src/mock-backend/oauthServer.ts)
 * -- proving the mock itself behaves, so a failure in a naimix test means
 * naimix, not the mock. ID tokens are checked with `jsonwebtoken` and the
 * published JWKS, an implementation independent of the mock's own signing.
 */

const REDIRECT = "https://app.test/callback";

let server: MockOAuthServerHandle;
let a: MockIssuerHandle;
let b: MockIssuerHandle;

beforeAll(async () => {
  server = await startMockOAuthServer();
  a = server.addIssuer("a", {
    clients: [
      { clientId: "web", clientSecret: "s3cret", redirectUris: [REDIRECT] },
      { clientId: "flex", clientSecret: "flex-secret", redirectUris: [REDIRECT], pkce: "optional" },
      { clientId: "legacy", clientSecret: "legacy-secret", redirectUris: [REDIRECT], pkce: "ignore" },
      { clientId: "spa", redirectUris: [REDIRECT] },
    ],
    users: [
      { sub: "user-1", email: "one@mock.test", claims: { name: "One" } },
      { sub: "user-2", email: "two@mock.test" },
    ],
  });
  b = server.addIssuer("b", { clients: [{ clientId: "web", clientSecret: "b-secret", redirectUris: [REDIRECT] }] });
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.clearRequests();
  a.reset();
  b.reset();
});

// ---- helpers --------------------------------------------------------------

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(issuer: MockIssuerHandle, params: Record<string, string>) {
  const url = new URL(issuer.authorizationEndpoint);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  return { status: res.status, location: location ? new URL(location) : undefined };
}

async function tokenRequest(issuer: MockIssuerHandle, form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(issuer.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

interface LoginOptions {
  clientId?: string;
  pkce?: boolean;
  scope?: string;
  nonce?: string;
  state?: string;
  loginHint?: string;
}

async function startLogin(issuer: MockIssuerHandle, opts: LoginOptions = {}) {
  const { verifier, challenge } = pkcePair();
  const params: Record<string, string> = {
    response_type: "code",
    client_id: opts.clientId ?? "web",
    redirect_uri: REDIRECT,
    scope: opts.scope ?? "openid offline_access",
    state: opts.state ?? "st-1",
    nonce: opts.nonce ?? "n-1",
  };
  if (opts.pkce !== false) {
    params.code_challenge = challenge;
    params.code_challenge_method = "S256";
  }
  if (opts.loginHint) params.login_hint = opts.loginHint;
  const result = await authorize(issuer, params);
  return { ...result, verifier, challenge, code: result.location?.searchParams.get("code") ?? undefined };
}

const SECRETS: Record<string, string | undefined> = { web: "s3cret", flex: "flex-secret", legacy: "legacy-secret", spa: undefined };

function exchangeForm(code: string, verifier: string | undefined, clientId = "web", extra: Record<string, string> = {}) {
  const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, ...extra };
  if (SECRETS[clientId]) form.client_secret = SECRETS[clientId]!;
  if (verifier) form.code_verifier = verifier;
  return form;
}

/** A complete login: authorize, then exchange the code. */
async function login(issuer: MockIssuerHandle, opts: LoginOptions = {}) {
  const start = await startLogin(issuer, opts);
  const token = await tokenRequest(issuer, exchangeForm(start.code!, opts.pkce === false ? undefined : start.verifier, opts.clientId));
  return { start, token };
}

async function verifyIdToken(issuer: MockIssuerHandle, idToken: string, audience = "web") {
  const header = JSON.parse(Buffer.from(idToken.split(".")[0], "base64url").toString());
  const jwks = (await (await fetch(issuer.jwksUri)).json()) as { keys: Array<Record<string, unknown>> };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`no JWKS key for kid ${header.kid}`);
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  return jwt.verify(idToken, key, { algorithms: ["RS256"], issuer: issuer.issuer, audience }) as jwt.JwtPayload;
}

// ---- discovery and keys -----------------------------------------------------

describe("discovery and JWKS", () => {
  it("publishes a discovery document whose endpoints belong to the issuer", async () => {
    const doc = (await (await fetch(a.discoveryUrl)).json()) as Record<string, any>;
    expect(doc.issuer).toBe(a.issuer);
    expect(doc.authorization_endpoint).toBe(a.authorizationEndpoint);
    expect(doc.token_endpoint).toBe(a.tokenEndpoint);
    expect(doc.jwks_uri).toBe(a.jwksUri);
    expect(doc.code_challenge_methods_supported).toContain("S256");
    expect(doc.authorization_response_iss_parameter_supported).toBeUndefined();
  });

  it("gives each issuer its own identity and keys", async () => {
    expect(a.issuer).not.toBe(b.issuer);
    const keysA = (await (await fetch(a.jwksUri)).json()) as { keys: Array<{ kid: string }> };
    const keysB = (await (await fetch(b.jwksUri)).json()) as { keys: Array<{ kid: string }> };
    expect(keysA.keys[0].kid).not.toBe(keysB.keys[0].kid);
  });

  it("404s an unknown issuer", async () => {
    const res = await fetch(`${server.baseUrl}/nope/jwks`);
    expect(res.status).toBe(404);
  });

  it("rotates keys: the old key stays published by default, and signing moves to the new one", async () => {
    const oldKid = a.currentKid();
    const newKid = a.rotateKeys();
    expect(newKid).not.toBe(oldKid);
    const jwks = (await (await fetch(a.jwksUri)).json()) as { keys: Array<{ kid: string }> };
    expect(jwks.keys.map((k) => k.kid)).toEqual([oldKid, newKid]);

    const { token } = await login(a);
    const claims = await verifyIdToken(a, token.json!.id_token);
    expect(JSON.parse(Buffer.from(token.json!.id_token.split(".")[0], "base64url").toString()).kid).toBe(newKid);
    expect(claims.sub).toBe("user-1");
  });

  it("retires the old key when asked", async () => {
    const newKid = a.rotateKeys({ retireOld: true });
    const jwks = (await (await fetch(a.jwksUri)).json()) as { keys: Array<{ kid: string }> };
    expect(jwks.keys.map((k) => k.kid)).toEqual([newKid]);
  });

  it("can make the JWKS endpoint fail, and recover", async () => {
    a.failJwks(503);
    expect((await fetch(a.jwksUri)).status).toBe(503);
    a.failJwks(null);
    expect((await fetch(a.jwksUri)).status).toBe(200);
  });
});

// ---- authorize ------------------------------------------------------------------

describe("/authorize", () => {
  it("redirects back with a code and the state, picking the default user", async () => {
    const start = await startLogin(a, { state: "abc" });
    expect(start.status).toBe(302);
    expect(start.location!.origin + start.location!.pathname).toBe(REDIRECT);
    expect(start.location!.searchParams.get("state")).toBe("abc");
    expect(start.code).toMatch(/^mock-code-/);
    expect(start.location!.searchParams.has("iss")).toBe(false);
  });

  it("selects the user from login_hint (sub or email)", async () => {
    const bySub = await login(a, { loginHint: "user-2" });
    expect((await verifyIdToken(a, bySub.token.json!.id_token)).sub).toBe("user-2");
    const byEmail = await login(a, { loginHint: "two@mock.test" });
    expect((await verifyIdToken(a, byEmail.token.json!.id_token)).sub).toBe("user-2");
  });

  it("answers an unknown login_hint with login_required", async () => {
    const start = await startLogin(a, { loginHint: "nobody" });
    expect(start.location!.searchParams.get("error")).toBe("login_required");
    expect(start.location!.searchParams.get("state")).toBe("st-1");
  });

  it("never redirects for an unknown client or an unregistered redirect_uri", async () => {
    const unknownClient = await authorize(a, { response_type: "code", client_id: "ghost", redirect_uri: REDIRECT });
    expect(unknownClient.status).toBe(400);
    expect(unknownClient.location).toBeUndefined();
    const badRedirect = await authorize(a, { response_type: "code", client_id: "web", redirect_uri: "https://evil.test/cb", code_challenge: "x", code_challenge_method: "S256" });
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.location).toBeUndefined();
  });

  it("rejects an unsupported response_type by redirecting with an error", async () => {
    const res = await authorize(a, { response_type: "token", client_id: "web", redirect_uri: REDIRECT, state: "s" });
    expect(res.location!.searchParams.get("error")).toBe("unsupported_response_type");
    expect(res.location!.searchParams.get("state")).toBe("s");
  });

  it("requires a code_challenge from a PKCE-required client, and supports S256 and plain only", async () => {
    const missing = await startLogin(a, { pkce: false });
    expect(missing.location!.searchParams.get("error")).toBe("invalid_request");
    const weird = await authorize(a, { response_type: "code", client_id: "web", redirect_uri: REDIRECT, code_challenge: "x", code_challenge_method: "S512" });
    expect(weird.location!.searchParams.get("error")).toBe("invalid_request");
  });

  it("adds the RFC 9207 iss parameter when the issuer is configured for it", async () => {
    const withIss = server.addIssuer("with-iss", { issParameter: true, clients: [{ clientId: "web", clientSecret: "s3cret", redirectUris: [REDIRECT] }] });
    const start = await startLogin(withIss);
    expect(start.location!.searchParams.get("iss")).toBe(withIss.issuer);
    const doc = (await (await fetch(withIss.discoveryUrl)).json()) as Record<string, any>;
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
  });
});

// ---- token: authorization code ----------------------------------------------------

describe("/token authorization_code", () => {
  it("exchanges a code for opaque tokens and a verifiable ID token carrying the nonce", async () => {
    const { token } = await login(a, { nonce: "nonce-xyz" });
    expect(token.status).toBe(200);
    expect(token.json).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(token.json!.access_token).toMatch(/^mock-access-/);
    expect(token.json!.refresh_token).toMatch(/^mock-refresh-/);
    const claims = await verifyIdToken(a, token.json!.id_token);
    expect(claims).toMatchObject({ iss: a.issuer, aud: "web", sub: "user-1", nonce: "nonce-xyz", name: "One" });
    expect(claims.exp! - claims.iat!).toBe(300);
  });

  it("issues no ID token without the openid scope", async () => {
    const { token } = await login(a, { scope: "profile" });
    expect(token.status).toBe(200);
    expect(token.json!.id_token).toBeUndefined();
  });

  it("verifies PKCE: a wrong or missing verifier is invalid_grant", async () => {
    const wrong = await startLogin(a);
    const r1 = await tokenRequest(a, exchangeForm(wrong.code!, "not-the-verifier"));
    expect(r1).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    const missing = await startLogin(a);
    const r2 = await tokenRequest(a, exchangeForm(missing.code!, undefined));
    expect(r2.json!.error).toBe("invalid_grant");
  });

  it("supports the plain challenge method", async () => {
    const res = await authorize(a, { response_type: "code", client_id: "web", redirect_uri: REDIRECT, code_challenge: "plain-verifier-value", code_challenge_method: "plain" });
    const ok = await tokenRequest(a, exchangeForm(res.location!.searchParams.get("code")!, "plain-verifier-value"));
    expect(ok.status).toBe(200);
  });

  it("rejects a code_verifier when the authorization request had no challenge (downgrade)", async () => {
    const start = await startLogin(a, { clientId: "flex", pkce: false });
    const res = await tokenRequest(a, exchangeForm(start.code!, "some-verifier", "flex"));
    expect(res.json!.error).toBe("invalid_grant");
  });

  it("lets an optional-PKCE client skip PKCE, and verifies it when used", async () => {
    const { token } = await login(a, { clientId: "flex", pkce: false });
    expect(token.status).toBe(200);
    const bad = await startLogin(a, { clientId: "flex" });
    expect((await tokenRequest(a, exchangeForm(bad.code!, "wrong", "flex"))).json!.error).toBe("invalid_grant");
  });

  it("lets an ignore-PKCE client behave like a provider without PKCE (never verifies)", async () => {
    const start = await startLogin(a, { clientId: "legacy" });
    const res = await tokenRequest(a, exchangeForm(start.code!, "anything-at-all", "legacy"));
    expect(res.status).toBe(200);
    const doc = (await (await fetch(a.discoveryUrl)).json()) as Record<string, any>;
    expect(doc.code_challenge_methods_supported).toBeDefined();
  });

  it("makes a code single-use, and a replay revokes the refresh token the first use issued", async () => {
    const start = await startLogin(a);
    const first = await tokenRequest(a, exchangeForm(start.code!, start.verifier));
    expect(first.status).toBe(200);
    const replay = await tokenRequest(a, exchangeForm(start.code!, start.verifier));
    expect(replay).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    const refresh = await tokenRequest(a, { grant_type: "refresh_token", refresh_token: first.json!.refresh_token, client_id: "web", client_secret: "s3cret" });
    expect(refresh.json!.error).toBe("invalid_grant");
  });

  it("rejects a mismatched redirect_uri, an unknown code, and a code from another issuer", async () => {
    const start = await startLogin(a);
    const mismatch = await tokenRequest(a, exchangeForm(start.code!, start.verifier, "web", { redirect_uri: "https://app.test/other" }));
    expect(mismatch.json!.error).toBe("invalid_grant");
    expect((await tokenRequest(a, exchangeForm("mock-code-unknown", "v"))).json!.error).toBe("invalid_grant");

    const fromA = await startLogin(a);
    const atB = await tokenRequest(b, { ...exchangeForm(fromA.code!, fromA.verifier), client_secret: "b-secret" });
    expect(atB.json!.error).toBe("invalid_grant");
  });

  it("expires codes after the TTL, by Date.now()", async () => {
    const start = await startLogin(a);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 120_000);
      const res = await tokenRequest(a, exchangeForm(start.code!, start.verifier));
      expect(res.json).toMatchObject({ error: "invalid_grant", error_description: "code expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes token times from Date.now(), so fake timers move the mock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const { token } = await login(a);
      const claims = jwt.decode(token.json!.id_token) as jwt.JwtPayload;
      expect(claims.iat).toBe(Math.floor(new Date("2030-01-01T00:00:00Z").getTime() / 1000));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unsupported grant type", async () => {
    const res = await tokenRequest(a, { grant_type: "password", client_id: "web", client_secret: "s3cret" });
    expect(res.json!.error).toBe("unsupported_grant_type");
  });
});

// ---- client authentication ----------------------------------------------------------

describe("client authentication", () => {
  it("accepts HTTP Basic and form-body credentials, and logs which was used", async () => {
    const s1 = await startLogin(a);
    const basic = await tokenRequest(a, exchangeForm(s1.code!, s1.verifier, "web", {}), {
      authorization: `Basic ${Buffer.from("web:s3cret").toString("base64")}`,
    });
    expect(basic.status).toBe(200);
    const s2 = await startLogin(a);
    expect((await tokenRequest(a, exchangeForm(s2.code!, s2.verifier))).status).toBe(200);
    expect(server.requestsFor("a", "token").map((r) => r.clientAuth)).toEqual(["basic", "post"]);
  });

  it("answers a wrong secret with 401 invalid_client", async () => {
    const start = await startLogin(a);
    const res = await tokenRequest(a, { ...exchangeForm(start.code!, start.verifier), client_secret: "wrong" });
    expect(res).toMatchObject({ status: 401, json: { error: "invalid_client" } });
  });

  it("serves a public client with no secret", async () => {
    const { token } = await login(a, { clientId: "spa" });
    expect(token.status).toBe(200);
    expect(server.requestsFor("a", "token")[0].clientAuth).toBe("none");
  });
});

// ---- refresh ----------------------------------------------------------------------------

describe("/token refresh_token", () => {
  const refreshForm = (refresh: string) => ({ grant_type: "refresh_token", refresh_token: refresh, client_id: "web", client_secret: "s3cret" });

  it("rotates the refresh token and retires the old one", async () => {
    const { token } = await login(a);
    const first = await tokenRequest(a, refreshForm(token.json!.refresh_token));
    expect(first.status).toBe(200);
    expect(first.json!.refresh_token).not.toBe(token.json!.refresh_token);
    expect(first.json!.id_token).toBeUndefined();
    const reuse = await tokenRequest(a, refreshForm(token.json!.refresh_token));
    expect(reuse.json!.error).toBe("invalid_grant");
  });

  it("keeps the same refresh token when rotation is off", async () => {
    const fixed = server.addIssuer("no-rotation", { rotateRefreshTokens: false, clients: [{ clientId: "web", clientSecret: "s3cret", redirectUris: [REDIRECT] }] });
    const { token } = await login(fixed);
    const refreshed = await tokenRequest(fixed, refreshForm(token.json!.refresh_token));
    expect(refreshed.json!.refresh_token).toBe(token.json!.refresh_token);
  });
});

// ---- scenarios: authorization-side faults -----------------------------------------------------

describe("scenarios: authorize", () => {
  it("redirects with an authorization error and the state", async () => {
    a.nextLogin({ authorize: { error: "access_denied", errorDescription: "user said no" } });
    const start = await startLogin(a, { state: "keep-me" });
    expect(start.code).toBeUndefined();
    expect(start.location!.searchParams.get("error")).toBe("access_denied");
    expect(start.location!.searchParams.get("error_description")).toBe("user said no");
    expect(start.location!.searchParams.get("state")).toBe("keep-me");
  });

  it("can drop or replace the state", async () => {
    a.nextLogin({ authorize: { omitState: true } });
    expect((await startLogin(a)).location!.searchParams.has("state")).toBe(false);
    a.nextLogin({ authorize: { state: "forged" } });
    expect((await startLogin(a)).location!.searchParams.get("state")).toBe("forged");
  });

  it("can send a wrong iss, or leave it out when the issuer would send one", async () => {
    a.nextLogin({ authorize: { iss: "https://evil.test" } });
    expect((await startLogin(a)).location!.searchParams.get("iss")).toBe("https://evil.test");
    const withIss = server.addIssuer("iss-null", { issParameter: true, clients: [{ clientId: "web", clientSecret: "s3cret", redirectUris: [REDIRECT] }] });
    withIss.nextLogin({ authorize: { iss: null } });
    expect((await startLogin(withIss)).location!.searchParams.has("iss")).toBe(false);
  });

  it("can answer with a plain HTTP error and no redirect", async () => {
    a.nextLogin({ authorize: { status: 503 } });
    const start = await startLogin(a);
    expect(start.status).toBe(503);
    expect(start.location).toBeUndefined();
  });

  it("applies a scenario to one login only, in queue order, and sticky ones to every login until reset", async () => {
    a.nextLogin({ authorize: { error: "access_denied" } });
    a.nextLogin({ authorize: { error: "server_error" } });
    expect((await startLogin(a)).location!.searchParams.get("error")).toBe("access_denied");
    expect((await startLogin(a)).location!.searchParams.get("error")).toBe("server_error");
    expect((await startLogin(a)).code).toBeDefined();

    a.everyLogin({ authorize: { error: "temporarily_unavailable" } });
    expect((await startLogin(a)).location!.searchParams.get("error")).toBe("temporarily_unavailable");
    expect((await startLogin(a)).location!.searchParams.get("error")).toBe("temporarily_unavailable");
    a.reset();
    expect((await startLogin(a)).code).toBeDefined();
  });
});

// ---- scenarios: token endpoint faults --------------------------------------------------------------

describe("scenarios: token endpoint", () => {
  it("answers with a 5xx", async () => {
    a.nextLogin({ token: { status: 500 } });
    const { token } = await login(a);
    expect(token.status).toBe(500);
  });

  it("answers with an OAuth error", async () => {
    a.nextLogin({ token: { error: "temporarily_unavailable", status: 503 } });
    const { token } = await login(a);
    expect(token).toMatchObject({ status: 503, json: { error: "temporarily_unavailable" } });
  });

  it("answers with a malformed body", async () => {
    a.nextLogin({ token: { body: "<html>not json</html>" } });
    const { token } = await login(a);
    expect(token.status).toBe(200);
    expect(token.json).toBeUndefined();
    expect(token.text).toContain("not json");
  });

  it("can leave out the ID token, the access token, or the refresh token", async () => {
    a.nextLogin({ token: { omitIdToken: true } });
    expect((await login(a)).token.json!.id_token).toBeUndefined();
    a.nextLogin({ token: { omitAccessToken: true } });
    expect((await login(a)).token.json!.access_token).toBeUndefined();
    a.nextLogin({ token: { omitRefreshToken: true } });
    expect((await login(a)).token.json!.refresh_token).toBeUndefined();
  });

  it("can delay a response", async () => {
    a.nextLogin({ token: { delayMs: 200 } });
    const start = await startLogin(a);
    const began = Date.now();
    await tokenRequest(a, exchangeForm(start.code!, start.verifier));
    expect(Date.now() - began).toBeGreaterThanOrEqual(180);
  });

  it("can hang, so a client timeout fires", async () => {
    a.nextLogin({ token: { hang: true } });
    const start = await startLogin(a);
    await expect(
      fetch(a.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(exchangeForm(start.code!, start.verifier)),
        signal: AbortSignal.timeout(300),
      })
    ).rejects.toThrow();
  });
});

// ---- scenarios: ID token faults ------------------------------------------------------------------------

describe("scenarios: ID token", () => {
  const idTokenFrom = async (fault: Parameters<MockIssuerHandle["nextLogin"]>[0]["idToken"], opts: LoginOptions = {}) => {
    a.nextLogin({ idToken: fault });
    const { token } = await login(a, opts);
    expect(token.status).toBe(200);
    return token.json!.id_token as string;
  };

  it("overrides claims: wrong iss, wrong aud, multi-value aud with azp", async () => {
    const wrongIss = await idTokenFrom({ claims: { iss: "https://evil.test" } });
    await expect(verifyIdToken(a, wrongIss)).rejects.toThrow(/issuer/);
    const wrongAud = await idTokenFrom({ claims: { aud: "someone-else" } });
    await expect(verifyIdToken(a, wrongAud)).rejects.toThrow(/audience/);
    const multi = await idTokenFrom({ claims: { aud: ["web", "other"], azp: "web" } });
    expect(await verifyIdToken(a, multi)).toMatchObject({ aud: ["web", "other"], azp: "web" });
  });

  it("can delete or change nonce and sub", async () => {
    const noNonce = await idTokenFrom({ claims: { nonce: undefined } });
    expect((jwt.decode(noNonce) as jwt.JwtPayload).nonce).toBeUndefined();
    const badNonce = await idTokenFrom({ claims: { nonce: "someone-elses" } });
    expect((jwt.decode(badNonce) as jwt.JwtPayload).nonce).toBe("someone-elses");
    const noSub = await idTokenFrom({ claims: { sub: undefined } });
    expect((jwt.decode(noSub) as jwt.JwtPayload).sub).toBeUndefined();
  });

  it("issues expired tokens and tokens issued in the future", async () => {
    const expired = await idTokenFrom({ expiresInSeconds: -120 });
    await expect(verifyIdToken(a, expired)).rejects.toThrow(/expired/);
    const before = Math.floor(Date.now() / 1000);
    const future = await idTokenFrom({ issuedAtOffsetSeconds: 600 });
    expect((jwt.decode(future) as jwt.JwtPayload).iat!).toBeGreaterThanOrEqual(before + 600);
  });

  it("signs with a key that is not in the JWKS", async () => {
    const token = await idTokenFrom({ signWith: "unknown" });
    await expect(verifyIdToken(a, token)).rejects.toThrow(/no JWKS key for kid/);
  });

  it("sends an unsigned alg:none token", async () => {
    const token = await idTokenFrom({ alg: "none" });
    const [header, , signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("none");
    expect(signature).toBe("");
    await expect(verifyIdToken(a, token)).rejects.toThrow();
  });

  it("sends an HS256 token signed with the public key (algorithm confusion)", async () => {
    const token = await idTokenFrom({ alg: "HS256-public-key" });
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).alg).toBe("HS256");
    await expect(verifyIdToken(a, token)).rejects.toThrow();
  });

  it("tampers with the payload after signing", async () => {
    const token = await idTokenFrom({ tamperPayload: { sub: "admin" } });
    expect((jwt.decode(token) as jwt.JwtPayload).sub).toBe("admin");
    await expect(verifyIdToken(a, token)).rejects.toThrow(/invalid signature/);
  });

  it("overrides or removes the kid header", async () => {
    const wrongKid = await idTokenFrom({ kid: "no-such-key" });
    await expect(verifyIdToken(a, wrongKid)).rejects.toThrow(/no JWKS key for kid no-such-key/);
    const noKid = await idTokenFrom({ kid: null });
    expect(JSON.parse(Buffer.from(noKid.split(".")[0], "base64url").toString()).kid).toBeUndefined();
  });
});

// ---- request log -----------------------------------------------------------------------------------------------

describe("request log", () => {
  it("records what the client sent to each endpoint", async () => {
    const { start, token } = await login(a, { nonce: "n-log", state: "s-log" });
    expect(token.status).toBe(200);

    const [authorizeReq] = server.requestsFor("a", "authorize");
    expect(authorizeReq.query).toMatchObject({
      client_id: "web",
      redirect_uri: REDIRECT,
      state: "s-log",
      nonce: "n-log",
      code_challenge: start.challenge,
      code_challenge_method: "S256",
    });

    const [tokenReq] = server.requestsFor("a", "token");
    expect(tokenReq.body).toMatchObject({ grant_type: "authorization_code", code: start.code, code_verifier: start.verifier, redirect_uri: REDIRECT });
    expect(tokenReq.clientAuth).toBe("post");

    await fetch(a.jwksUri);
    expect(server.requestsFor("a", "jwks")).toHaveLength(1);
    expect(server.requestsFor("b", "authorize")).toHaveLength(0);
  });

  it("can be cleared", async () => {
    await startLogin(a);
    expect(server.requests.length).toBeGreaterThan(0);
    server.clearRequests();
    expect(server.requests).toHaveLength(0);
  });
});
