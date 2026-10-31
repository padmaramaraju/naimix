import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { createAdminRouter } from "./oauthAdmin";

/**
 * In-process mock OAuth2 / OpenID Connect provider for the automated test
 * suite -- the OAuth counterpart to startFakeLdapServer() (ldapServer.ts)
 * and startMockBackend() (index.ts). Built to test naimix's Authorization
 * Code flow (src/auth/oauthCodeFlow.ts, src/server/authRoutes.ts): happy
 * paths, but mostly the ways a provider can go wrong, which no off-the-shelf
 * mock lets a test produce on demand (see AUTH_DESIGN_NOTES.md,
 * "Authorization Code: what's built, plus planned changes").
 *
 * What it is:
 * - Several issuers in one process, each under its own path prefix
 *   (`{baseUrl}/{issuerId}/authorize`, `/token`, `/jwks`,
 *   `/.well-known/openid-configuration`), each with its own signing keys,
 *   clients and users -- so cross-provider mix-up tests are possible.
 * - A headless `/authorize`: it approves immediately and redirects back
 *   with a code. `login_hint` picks the user (a `sub` or `email`).
 * - A strict-by-default `/token` for the authorization_code and
 *   refresh_token grants: exact redirect_uri match, single-use and expiring
 *   codes (a replay revokes what the first exchange issued), PKCE
 *   verification per client (`required` / `optional` / `ignore`), client
 *   authentication via Basic or form body, rotating refresh tokens.
 * - RS256 ID tokens (when `openid` is in the scope) with a published JWKS,
 *   `nonce` echoed from the authorization request, and key rotation.
 * - Scenarios: make the NEXT login (or every login) misbehave -- an
 *   authorization error, a missing or wrong `state`, a wrong `iss`, a 5xx
 *   or malformed token response, a tampered / expired / unsigned /
 *   wrongly-signed ID token, a hung or slow endpoint.
 * - A request log, so a test can assert what naimix actually sent.
 *
 * What it is not: a real provider. No userinfo, device flow, client
 * credentials, implicit or password grants (the existing /oauth/* routes in
 * index.ts still cover those); no consent screen or login page.
 *
 * Time: everything reads `Date.now()`, so `vi.useFakeTimers({ toFake:
 * ["Date"] })` moves the mock and naimix together. `delayMs` uses a real
 * setTimeout, so it doesn't mix with faked timers.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How a client's PKCE is treated: `required` rejects an authorization
 * request without a code_challenge; `optional` accepts one without (and
 * verifies when present); `ignore` behaves like a provider that doesn't
 * implement PKCE at all -- it never verifies a verifier. */
export type PkceMode = "required" | "optional" | "ignore";

export interface MockClient {
  clientId: string;
  /** Omit for a public client (no secret needed at the token endpoint). */
  clientSecret?: string;
  /** Exact-match allow-list. Anything else gets a plain 400, never a redirect. */
  redirectUris: string[];
  /** Default "required". */
  pkce?: PkceMode;
}

export interface MockUser {
  sub: string;
  /** Matched against `login_hint` along with `sub`. */
  email?: string;
  /** Extra ID token claims. The standard ones (iss, sub, aud, iat, exp, nonce) always win. */
  claims?: Record<string, unknown>;
}

export interface MockIssuerOptions {
  clients: MockClient[];
  /** Default: one user, `mock-user-1`. The first user is the default login. */
  users?: MockUser[];
  /** Add the RFC 9207 `iss` parameter to authorization responses. Default false. */
  issParameter?: boolean;
  /** Default 3600. */
  accessTokenTtlSeconds?: number;
  /** Default 300. */
  idTokenTtlSeconds?: number;
  /** Default 60. */
  codeTtlSeconds?: number;
  /** Issue a new refresh token on every refresh (and retire the old one). Default true. */
  rotateRefreshTokens?: boolean;
}

export interface AuthorizeFault {
  /** Redirect back with `error=<this>` instead of a code. */
  error?: string;
  errorDescription?: string;
  /** Leave `state` out of the redirect. */
  omitState?: boolean;
  /** Send this `state` instead of the one that was received. */
  state?: string;
  /** A string sends that `iss` parameter; null leaves it out; undefined follows the issuer's setting. */
  iss?: string | null;
  /** Answer with this plain HTTP status and no redirect. */
  status?: number;
  delayMs?: number;
}

export interface TokenFault {
  /** An OAuth error response (`{"error": ...}`) with `status` (default 400). */
  error?: string;
  errorDescription?: string;
  /** Replace the whole response: a string is sent raw, an object as JSON. `status` defaults to 200. */
  body?: string | Record<string, unknown>;
  status?: number;
  omitIdToken?: boolean;
  omitAccessToken?: boolean;
  omitRefreshToken?: boolean;
  delayMs?: number;
  /** Never answer. */
  hang?: boolean;
}

export interface IdTokenFault {
  /** Set claims; a value of `undefined` deletes the claim. */
  claims?: Record<string, unknown>;
  /** Seconds from now (negative = already expired). */
  expiresInSeconds?: number;
  /** Seconds added to the issued-at time (positive = in the future). */
  issuedAtOffsetSeconds?: number;
  /** `unknown` signs with a key that is NOT in the JWKS. */
  signWith?: "current" | "unknown";
  /** `none` sends an unsigned token; `HS256-public-key` signs with HMAC using the public key as the secret. */
  alg?: "RS256" | "none" | "HS256-public-key";
  /** Change the payload after signing, so the signature no longer matches. */
  tamperPayload?: Record<string, unknown>;
  /** A string overrides the `kid` header; null leaves it out. */
  kid?: string | null;
}

/** Misbehavior for one login. `authorize` applies when the browser hits
 * /authorize; `token` and `idToken` apply to that same login's code exchange. */
export interface Scenario {
  authorize?: AuthorizeFault;
  token?: TokenFault;
  idToken?: IdTokenFault;
}

export type MockEndpoint = "discovery" | "authorize" | "token" | "jwks";

export interface RecordedRequest {
  issuerId: string;
  endpoint: MockEndpoint;
  method: string;
  query: Record<string, string>;
  /** Parsed form body (token endpoint). */
  body: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Token endpoint only: how the client authenticated. */
  clientAuth?: "basic" | "post" | "none";
  at: number;
}

export interface MockIssuerHandle {
  readonly id: string;
  /** The issuer identifier: `{baseUrl}/{id}`, no trailing slash. */
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** The next login (one) misbehaves as described. Calls queue up in order. */
  nextLogin(scenario: Scenario): void;
  /** Every login misbehaves until reset(). */
  everyLogin(scenario: Scenario): void;
  /** Clears queued and sticky scenarios and any JWKS failure. */
  reset(): void;
  /** Generates a new signing key and uses it from now on. The old key stays in the JWKS unless `retireOld`. Returns the new `kid`. */
  rotateKeys(options?: { retireOld?: boolean }): string;
  /** The `kid` of the key currently signing ID tokens. */
  currentKid(): string;
  /** Make the JWKS endpoint answer with this status (null restores it). */
  failJwks(status: number | null): void;
  /** A snapshot of this issuer's configuration (used by the admin UI). */
  config(): { clients: MockClient[]; users: MockUser[]; issParameter: boolean };
  /** Adds a client to a running issuer. Throws if the clientId is taken. */
  addClient(client: MockClient): void;
  /** Adds a user to a running issuer. Throws if the sub is taken. */
  addUser(user: MockUser): void;
}

export interface MockOAuthServerHandle {
  /** `http://127.0.0.1:{port}` */
  readonly baseUrl: string;
  addIssuer(id: string, options: MockIssuerOptions): MockIssuerHandle;
  issuer(id: string): MockIssuerHandle;
  /** All issuers, in creation order. */
  issuers(): MockIssuerHandle[];
  /** Every request received, oldest first. */
  readonly requests: RecordedRequest[];
  requestsFor(issuerId: string, endpoint: MockEndpoint): RecordedRequest[];
  clearRequests(): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const b64url = (value: unknown): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

interface SigningKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  jwk: Record<string, unknown>;
}

function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `mock-key-${crypto.randomBytes(4).toString("hex")}`;
  return { kid, privateKey, publicKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } };
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  alg: "RS256" | "HS256" | "none",
  key?: crypto.KeyObject | string
): string {
  const input = `${b64url({ ...header, alg })}.${b64url(payload)}`;
  if (alg === "none") return `${input}.`;
  if (alg === "HS256") return `${input}.${crypto.createHmac("sha256", key as string).update(input).digest("base64url")}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), key as crypto.KeyObject).toString("base64url")}`;
}

const sha256b64url = (value: string): string => crypto.createHash("sha256").update(value).digest("base64url");
const randomToken = (prefix: string): string => `${prefix}-${crypto.randomBytes(16).toString("hex")}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Per-issuer state
// ---------------------------------------------------------------------------

interface ResolvedOptions {
  clients: MockClient[];
  users: MockUser[];
  issParameter: boolean;
  accessTokenTtlSeconds: number;
  idTokenTtlSeconds: number;
  codeTtlSeconds: number;
  rotateRefreshTokens: boolean;
}

interface AuthCodeRecord {
  id: string;
  clientId: string;
  redirectUri: string;
  challenge?: string;
  method?: "S256" | "plain";
  nonce?: string;
  userSub: string;
  scope: string;
  scenario?: Scenario;
  used: boolean;
  createdAt: number;
}

interface RefreshRecord {
  clientId: string;
  userSub: string;
  scope: string;
  codeId: string;
}

class IssuerState {
  keys: SigningKey[];
  current: SigningKey;
  jwksFault: number | null = null;
  readonly codes = new Map<string, AuthCodeRecord>();
  readonly refreshTokens = new Map<string, RefreshRecord>();
  private queue: Scenario[] = [];
  private sticky: Scenario | undefined;
  private unknown: SigningKey | undefined;

  constructor(
    readonly id: string,
    readonly options: ResolvedOptions,
    private readonly getBaseUrl: () => string
  ) {
    this.current = generateSigningKey();
    this.keys = [this.current];
  }

  get issuer(): string {
    return `${this.getBaseUrl()}/${this.id}`;
  }

  unknownKey(): SigningKey {
    if (!this.unknown) this.unknown = generateSigningKey();
    return this.unknown;
  }

  nextLogin(scenario: Scenario): void {
    this.queue.push(scenario);
  }

  everyLogin(scenario: Scenario): void {
    this.sticky = scenario;
  }

  takeScenario(): Scenario | undefined {
    return this.queue.shift() ?? this.sticky;
  }

  reset(): void {
    this.queue = [];
    this.sticky = undefined;
    this.jwksFault = null;
  }

  rotateKeys(retireOld: boolean): string {
    const key = generateSigningKey();
    this.keys = retireOld ? [key] : [...this.keys, key];
    this.current = key;
    return key.kid;
  }

  mintIdToken(client: MockClient, userSub: string, nonce: string | undefined, fault: IdTokenFault = {}): string {
    const user = this.options.users.find((u) => u.sub === userSub);
    const now = Math.floor(Date.now() / 1000);
    const iat = now + (fault.issuedAtOffsetSeconds ?? 0);
    const exp = fault.expiresInSeconds !== undefined ? now + fault.expiresInSeconds : iat + this.options.idTokenTtlSeconds;
    const claims: Record<string, unknown> = {
      ...(user?.claims ?? {}),
      iss: this.issuer,
      sub: userSub,
      aud: client.clientId,
      iat,
      exp,
      ...(nonce ? { nonce } : {}),
    };
    for (const [name, value] of Object.entries(fault.claims ?? {})) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }

    const key = fault.signWith === "unknown" ? this.unknownKey() : this.current;
    const header: Record<string, unknown> = { typ: "JWT" };
    const kid = fault.kid === undefined ? key.kid : fault.kid;
    if (kid !== null) header.kid = kid;

    const alg = fault.alg ?? "RS256";
    let token: string;
    if (alg === "none") {
      token = signJwt(header, claims, "none");
    } else if (alg === "HS256-public-key") {
      token = signJwt(header, claims, "HS256", this.current.publicKey.export({ type: "spki", format: "pem" }) as string);
    } else {
      token = signJwt(header, claims, "RS256", key.privateKey);
    }
    if (fault.tamperPayload) {
      const [h, , s] = token.split(".");
      token = `${h}.${b64url({ ...claims, ...fault.tamperPayload })}.${s}`;
    }
    return token;
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.originalUrl, "http://mock").searchParams);
}

function readClientAuth(req: Request): { clientId?: string; clientSecret?: string; method: "basic" | "post" | "none" } {
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) {
      try {
        // RFC 6749 2.3.1: id and secret are form-urlencoded before Base64.
        return {
          clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")),
          clientSecret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")),
          method: "basic",
        };
      } catch {
        return { method: "basic" };
      }
    }
  }
  const body = (req.body ?? {}) as Record<string, string>;
  return { clientId: body.client_id, clientSecret: body.client_secret, method: body.client_secret ? "post" : "none" };
}

function oauthError(res: Response, status: number, error: string, description?: string): void {
  res
    .status(status)
    .set({ "Cache-Control": "no-store", Pragma: "no-cache" })
    .json({ error, ...(description ? { error_description: description } : {}) });
}

/** Applies a token-endpoint fault. Returns true when it already answered (or deliberately never will). */
async function applyTokenFault(fault: TokenFault | undefined, res: Response): Promise<boolean> {
  if (!fault) return false;
  if (fault.hang) return true;
  if (fault.delayMs) await sleep(fault.delayMs);
  if (fault.error) {
    oauthError(res, fault.status ?? 400, fault.error, fault.errorDescription);
    return true;
  }
  if (fault.body !== undefined || fault.status !== undefined) {
    const status = fault.status ?? 200;
    if (typeof fault.body === "string") res.status(status).type("application/json").send(fault.body);
    else res.status(status).json(fault.body ?? { error: "server_error" });
    return true;
  }
  return false;
}

function discoveryDocument(st: IssuerState): Record<string, unknown> {
  const pkceSupported = st.options.clients.some((c) => (c.pkce ?? "required") !== "ignore");
  return {
    issuer: st.issuer,
    authorization_endpoint: `${st.issuer}/authorize`,
    token_endpoint: `${st.issuer}/token`,
    jwks_uri: `${st.issuer}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    ...(pkceSupported ? { code_challenge_methods_supported: ["S256", "plain"] } : {}),
    ...(st.options.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
  };
}

export interface MockOAuthServerOptions {
  port?: number;
  host?: string;
  /** Serve the admin UI and API at `/admin` (see oauthAdmin.ts). Default false. */
  admin?: boolean;
}

export async function startMockOAuthServer(options: MockOAuthServerOptions = {}): Promise<MockOAuthServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const issuers = new Map<string, IssuerState>();
  const handles = new Map<string, MockIssuerHandle>();
  const requests: RecordedRequest[] = [];
  let baseUrl = "";

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // Late-bound: the admin router needs the handle, which exists only once
  // the server is listening.
  let adminRouter: express.RequestHandler | undefined;
  if (options.admin) {
    app.use("/admin", (req, res, next) => (adminRouter ? adminRouter(req, res, next) : next()));
  }

  const record = (st: IssuerState, endpoint: MockEndpoint, req: Request, clientAuth?: RecordedRequest["clientAuth"]) => {
    requests.push({
      issuerId: st.id,
      endpoint,
      method: req.method,
      query: queryOf(req),
      body: { ...((req.body ?? {}) as Record<string, string>) },
      headers: { ...req.headers },
      clientAuth,
      at: Date.now(),
    });
    // The admin UI is for long-running manual use, so bound the log there;
    // tests (no admin) keep every request.
    if (options.admin && requests.length > 1000) requests.splice(0, requests.length - 1000);
  };

  const route =
    (fn: (req: Request, res: Response, st: IssuerState) => Promise<void> | void) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const st = issuers.get(req.params.issuerId);
      if (!st) {
        res.status(404).json({ error: "unknown_issuer" });
        return;
      }
      try {
        await fn(req, res, st);
      } catch (err) {
        next(err);
      }
    };

  app.get(
    "/:issuerId/.well-known/openid-configuration",
    route((req, res, st) => {
      record(st, "discovery", req);
      res.json(discoveryDocument(st));
    })
  );

  app.get(
    "/:issuerId/jwks",
    route((req, res, st) => {
      record(st, "jwks", req);
      if (st.jwksFault !== null) {
        res.status(st.jwksFault).json({ error: "server_error" });
        return;
      }
      res.json({ keys: st.keys.map((k) => k.jwk) });
    })
  );

  app.get(
    "/:issuerId/authorize",
    route(async (req, res, st) => {
      const q = queryOf(req);
      record(st, "authorize", req);
      const scenario = st.takeScenario();
      const fault = scenario?.authorize;
      if (fault?.delayMs) await sleep(fault.delayMs);
      if (fault?.status !== undefined) {
        res.status(fault.status).type("text/plain").send("mock authorize fault");
        return;
      }

      // Until the client and redirect_uri check out, nothing redirects: an
      // unverified redirect_uri is exactly the open-redirect hole.
      const client = st.options.clients.find((c) => c.clientId === q.client_id);
      if (!client) {
        res.status(400).json({ error: "invalid_request", error_description: "unknown client_id" });
        return;
      }
      if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
        res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is not registered for this client" });
        return;
      }

      const redirectBack = (params: Record<string, string>) => {
        const dest = new URL(q.redirect_uri);
        for (const [name, value] of Object.entries(params)) dest.searchParams.set(name, value);
        const state = fault?.omitState ? undefined : (fault?.state ?? q.state);
        if (state !== undefined) dest.searchParams.set("state", state);
        const iss = fault?.iss === null ? undefined : (fault?.iss ?? (st.options.issParameter ? st.issuer : undefined));
        if (iss !== undefined) dest.searchParams.set("iss", iss);
        res.redirect(302, dest.href);
      };
      const fail = (error: string, description?: string) =>
        redirectBack({ error, ...(description ? { error_description: description } : {}) });

      if (q.response_type !== "code") return fail("unsupported_response_type");

      const mode = client.pkce ?? "required";
      let challenge: string | undefined;
      let method: "S256" | "plain" | undefined;
      if (mode !== "ignore" && q.code_challenge) {
        const requested = q.code_challenge_method ?? "plain";
        if (requested !== "S256" && requested !== "plain") return fail("invalid_request", "unsupported code_challenge_method");
        challenge = q.code_challenge;
        method = requested;
      } else if (mode === "required") {
        return fail("invalid_request", "code_challenge is required");
      }

      if (fault?.error) return fail(fault.error, fault.errorDescription);

      let userSub = st.options.users[0].sub;
      if (q.login_hint) {
        const user = st.options.users.find((u) => u.sub === q.login_hint || u.email === q.login_hint);
        if (!user) return fail("login_required", "no user matches login_hint");
        userSub = user.sub;
      }

      const code = randomToken("mock-code");
      st.codes.set(code, {
        id: code,
        clientId: client.clientId,
        redirectUri: q.redirect_uri,
        challenge,
        method,
        nonce: q.nonce,
        userSub,
        scope: q.scope ?? "",
        scenario,
        used: false,
        createdAt: Date.now(),
      });
      redirectBack({ code });
    })
  );

  app.post(
    "/:issuerId/token",
    route(async (req, res, st) => {
      const body = (req.body ?? {}) as Record<string, string>;
      const auth = readClientAuth(req);
      record(st, "token", req, auth.method);

      const client = st.options.clients.find((c) => c.clientId === auth.clientId);
      if (!client || (client.clientSecret !== undefined && client.clientSecret !== auth.clientSecret)) {
        if (auth.method === "basic") res.set("WWW-Authenticate", 'Basic realm="mock"');
        oauthError(res, 401, "invalid_client");
        return;
      }

      const respond = (rec: Pick<AuthCodeRecord, "userSub" | "scope" | "nonce" | "id" | "scenario">, fault: TokenFault | undefined, withIdToken: boolean, reuseRefresh?: string) => {
        const out: Record<string, unknown> = {};
        if (!fault?.omitAccessToken) out.access_token = randomToken("mock-access");
        out.token_type = "Bearer";
        out.expires_in = st.options.accessTokenTtlSeconds;
        if (!fault?.omitRefreshToken) {
          const refresh = reuseRefresh ?? randomToken("mock-refresh");
          st.refreshTokens.set(refresh, { clientId: client.clientId, userSub: rec.userSub, scope: rec.scope, codeId: rec.id });
          out.refresh_token = refresh;
        }
        if (rec.scope) out.scope = rec.scope;
        if (withIdToken && rec.scope.split(" ").includes("openid") && !fault?.omitIdToken) {
          out.id_token = st.mintIdToken(client, rec.userSub, rec.nonce, rec.scenario?.idToken);
        }
        res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).json(out);
      };

      if (body.grant_type === "authorization_code") {
        const rec = st.codes.get(body.code ?? "");
        if (rec?.scenario?.token && (await applyTokenFault(rec.scenario.token, res))) return;
        if (!rec) return oauthError(res, 400, "invalid_grant", "unknown code");
        if (rec.used) {
          // RFC 6749 4.1.2: a replayed code revokes what the first use issued.
          for (const [token, r] of st.refreshTokens) if (r.codeId === rec.id) st.refreshTokens.delete(token);
          return oauthError(res, 400, "invalid_grant", "code already used");
        }
        rec.used = true;
        if (rec.clientId !== client.clientId) return oauthError(res, 400, "invalid_grant", "code was issued to a different client");
        if (Date.now() - rec.createdAt > st.options.codeTtlSeconds * 1000) return oauthError(res, 400, "invalid_grant", "code expired");
        if (body.redirect_uri !== rec.redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");

        if ((client.pkce ?? "required") !== "ignore") {
          if (rec.challenge) {
            const verifier = body.code_verifier;
            const ok = verifier && (rec.method === "S256" ? sha256b64url(verifier) === rec.challenge : verifier === rec.challenge);
            if (!ok) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
          } else if (body.code_verifier) {
            // A verifier with no challenge on record is a downgrade attempt.
            return oauthError(res, 400, "invalid_grant", "code_verifier sent but the authorization request had no code_challenge");
          }
        }
        return respond(rec, rec.scenario?.token, true);
      }

      if (body.grant_type === "refresh_token") {
        const rec = st.refreshTokens.get(body.refresh_token ?? "");
        if (!rec || rec.clientId !== client.clientId) return oauthError(res, 400, "invalid_grant", "unknown refresh token");
        if (st.options.rotateRefreshTokens) st.refreshTokens.delete(body.refresh_token);
        return respond(
          { id: rec.codeId, userSub: rec.userSub, scope: rec.scope, nonce: undefined, scenario: undefined },
          undefined,
          false,
          st.options.rotateRefreshTokens ? undefined : body.refresh_token
        );
      }

      oauthError(res, 400, "unsupported_grant_type");
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "server_error", error_description: err instanceof Error ? err.message : String(err) });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  baseUrl = `http://${host}:${(server.address() as AddressInfo).port}`;

  const handle: MockOAuthServerHandle = {
    baseUrl,
    requests,
    addIssuer(id, issuerOptions) {
      if (issuers.has(id)) throw new Error(`Issuer "${id}" already exists`);
      if (id === "admin") throw new Error(`"admin" is reserved for the admin UI`);
      const st = new IssuerState(
        id,
        {
          clients: issuerOptions.clients,
          users: issuerOptions.users ?? [{ sub: "mock-user-1", email: "user1@mock.test", claims: { name: "Mock User One", email: "user1@mock.test" } }],
          issParameter: issuerOptions.issParameter ?? false,
          accessTokenTtlSeconds: issuerOptions.accessTokenTtlSeconds ?? 3600,
          idTokenTtlSeconds: issuerOptions.idTokenTtlSeconds ?? 300,
          codeTtlSeconds: issuerOptions.codeTtlSeconds ?? 60,
          rotateRefreshTokens: issuerOptions.rotateRefreshTokens ?? true,
        },
        () => baseUrl
      );
      issuers.set(id, st);
      const issuerHandle: MockIssuerHandle = {
        id,
        issuer: st.issuer,
        discoveryUrl: `${st.issuer}/.well-known/openid-configuration`,
        authorizationEndpoint: `${st.issuer}/authorize`,
        tokenEndpoint: `${st.issuer}/token`,
        jwksUri: `${st.issuer}/jwks`,
        nextLogin: (scenario) => st.nextLogin(scenario),
        everyLogin: (scenario) => st.everyLogin(scenario),
        reset: () => st.reset(),
        rotateKeys: (rotateOptions) => st.rotateKeys(rotateOptions?.retireOld ?? false),
        currentKid: () => st.current.kid,
        failJwks: (status) => {
          st.jwksFault = status;
        },
        config: () => ({
          clients: st.options.clients.map((c) => ({ ...c, redirectUris: [...c.redirectUris] })),
          users: st.options.users.map((u) => ({ ...u })),
          issParameter: st.options.issParameter,
        }),
        addClient: (c) => {
          if (st.options.clients.some((x) => x.clientId === c.clientId)) throw new Error(`Client "${c.clientId}" already exists`);
          st.options.clients.push(c);
        },
        addUser: (u) => {
          if (st.options.users.some((x) => x.sub === u.sub)) throw new Error(`User "${u.sub}" already exists`);
          st.options.users.push(u);
        },
      };
      handles.set(id, issuerHandle);
      return issuerHandle;
    },
    issuer(id) {
      const found = handles.get(id);
      if (!found) throw new Error(`Unknown issuer "${id}"`);
      return found;
    },
    issuers: () => [...handles.values()],
    requestsFor: (issuerId, endpoint) => requests.filter((r) => r.issuerId === issuerId && r.endpoint === endpoint),
    clearRequests: () => {
      requests.length = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A "hang" scenario leaves a request open; don't wait for it.
        server.closeAllConnections();
      }),
  };
  if (options.admin) adminRouter = createAdminRouter(handle);
  return handle;
}
