# Authentication & Backend Token Exchange — Design Notes

**Status: phases 1–3 built** (generic backend-login + OAuth password/client_credentials, LDAP/AD bind, and OAuth Authorization Code — see "Suggested phased build order" below and `README.md`'s "Caller authentication"). Phase 4 (SAML) remains a brainstorm only; the rest of this document is kept for the design reasoning behind what's already built, not just what's still pending.

## The problem

Add support for authenticating the callers of this middleware's own business endpoints (not the console UI, which stays gated by `CONSOLE_TOKEN` as it is today) against enterprise identity systems — OAuth, Active Directory, LDAP, SAML, or a plain username/password — and use that login to obtain a token from the actual backend system. The middleware should hold onto that backend token, hand the caller back its own opaque session token, and on every subsequent request resolve that opaque token back to the real backend token before calling out.

This splits into two concerns worth keeping distinct: verifying who the caller is (authentication), and custody of a backend-issued credential attached to outgoing calls on that caller's behalf (token exchange/injection). They have different lifetimes and different security postures, and neither should be confused with `CONSOLE_TOKEN`, which protects a different audience (whoever configures this instance) entirely.

## Proposed architecture

- **`AuthProvider` abstraction**, parallel to how `callBackend()` already dispatches to a connector per backend type (json/xml/soap/sql). Each provider kind (oauth2, ldap, ad, saml, basicBackendLogin) implements the same shape: given credentials, produce a backend token (+ optional refresh token + expiry).
- **Config model**: a new `authProviders` section alongside `gateways`, using the same `${env.VAR}` convention gateway secrets already use — nothing new to remember about where secrets live or that they must stay out of the shared Git workspace.
- **Where the requirement lives — decided**: on the *gateway* (`requiresAuth: someProviderName`), not per-endpoint — a gateway represents one backend connection, and auth is a property of that connection, matching how `baseUrl`/`headers` already work.
- **Login/exchange flow**: new routes, e.g. `POST /auth/login/{providerName}`, separate from both `/console/api/*` and the business endpoints. On success, store `{ backendToken, refreshToken?, expiresAt, providerName, subject }` keyed by a newly minted opaque token, return that opaque token to the caller.
- **Injection into outgoing calls**: the dispatcher resolves the caller's opaque token to a session, then injects the backend token into `ctx.params` under a reserved name (e.g. `__authToken`) *before* `substituteParams()` runs — so a gateway's header config becomes `headers: { Authorization: "Bearer {__authToken}" }` with zero connector code changes, reusing the existing `{param}` substitution engine as-is.

## Per-protocol notes

- **Simple username/password** and **OAuth password/client_credentials grants** are the easy tier — structurally identical (POST credentials, extract a token from the JSON response), and can practically reuse the existing JSON connector plus the existing JSONPath output-mapper to pull the token/expiry fields out of the login response.
- **LDAP / Active Directory — decided**: AD is treated as plain LDAP simple-bind for phase 1; a bind either succeeds or fails, and there's no native "token" to relay, so the middleware mints its *own* signed token as the stand-in "backend token" for LDAP/AD-authenticated sessions, usable only by backends configured to trust this middleware directly. Real Kerberos/SSO (SPNEGO) is confirmed deferred to a later phase, not this one.
- **OAuth Authorization Code** (full write-up below) — doable, needs two new endpoints and short-lived flow state.
- **SAML**: its Assertion Consumer Service endpoint plays the identical structural role to the OAuth callback below. Hosting a full SAML Service Provider is a much bigger component (metadata, redirect endpoints, assertion validation); recommend scoping v1 down to "accept an assertion some other app already obtained" rather than being a full SP, unless there's a specific need to be the SP.

### OAuth Authorization Code — the redirect flow in detail

Two new endpoints:

- `GET /auth/oauth/{provider}/start` — generates a single-use `state` (+ PKCE `code_verifier`/`code_challenge`), stores it with a short TTL, redirects the browser to the provider's `/authorize` endpoint with our `redirect_uri`.
- `GET /auth/oauth/{provider}/callback` — this **is** the registered `redirect_uri`. Validates `state`, exchanges the `code` for tokens at the provider's token endpoint, and stores the resulting session exactly like every other provider.

Two things are genuinely new versus the simpler grants:

1. **Surviving the round trip.** The initiation and callback are two separate HTTP requests. The short-lived pending-flow state (`state → { codeVerifier, ... }`) must live in the *same shared store* as sessions (see load-balancing below) — in a multi-instance deployment, the initiation request and the callback are near-certain to land on different instances.
2. **Handing the final token to the right party — decided, with follow-on questions.** The end user is a human interacting through a web application or mobile application (not directly through this server's own UI) — so the initiation step accepts a `return_to` from the calling app, and the callback's last step redirects back to it with the token attached, rather than the middleware showing its own page. That decision opens three new things worth pinning down before building this:
   - **Who is the registered OAuth client, us or them?** Two different shapes fit "a web/mobile app plus this middleware": (a) *this middleware is the one registered client* with the real provider (one `client_id`/`client_secret`), it does the whole code exchange, and hands the calling app *our own* opaque token at the end — matching the original framing of this whole feature; or (b) *the web/mobile app is already its own registered OAuth client* and simply hands the middleware a token it already obtained, asking the middleware to take custody of it and manage refresh from then on — no `/start`/`/callback` endpoints needed at all in that case, just something like `POST /auth/import-token`. These are genuinely different builds. Working assumption unless told otherwise: (a), since it matches "the token issued should be saved within this server" from the original ask.
   - **Mobile apps need a different redirect mechanism than web apps.** A web app can receive a normal HTTPS redirect back to its own `return_to` URL. A mobile app generally can't the same way — the standard approach (RFC 8252, OAuth for native apps) has the app open the authorization step in an in-app browser tab and receive the final redirect via a custom URI scheme (`myapp://oauth-callback`) or a claimed universal/app link, which the OS routes directly back into the app rather than through a generic web page. The design needs to accept either kind of `return_to` and treat mobile as a first-class case, not an afterthought bolted onto the web flow.
   - **Open-redirect risk — `return_to` needs an allow-list.** Once the callback's last act is "redirect to whatever URL the initiation request said," that's a classic open-redirect vulnerability unless `return_to` is checked against a pre-registered set of allowed destinations per calling app. In effect, this middleware becomes a small OAuth-like broker with its own notion of "registered client apps" (a name, one or more allowed `return_to` patterns — an HTTPS origin for a web app, a custom scheme for a mobile app), separate from and much lighter than the *real* provider's own client registration. Worth deciding whether that registry lives in config (a new `clients:` section) or needs an console-UI-managed store.

Security must-haves: `state` must be unpredictable and single-use (CSRF/replay protection); PKCE recommended even for this confidential client (defense-in-depth, and effectively mandatory once mobile apps are in the mix per RFC 8252); `redirect_uri` (the one registered with the *real* provider) must exactly match what's registered there, which in practice means the load balancer's public URL, not any one instance's address; the callback endpoint necessarily sits outside the normal bearer-token gate, since the arriving browser has no credential yet. Recommend `openid-client` (spec-compliant) over hand-rolling this.

## Token model: opaque vs JWT

**Recommendation: opaque token** for the middleware's own session identifier.

An opaque token is a meaningless random string — a lookup key into server-side storage, revocable instantly by deleting the record, revealing nothing if intercepted. A JWT is self-contained and independently verifiable (signed, readable payload) without a lookup — but revocation before expiry requires a separate deny-list mechanism, which reintroduces the lookup a JWT was supposed to avoid.

The deciding factor here: the whole point of this design is retrieving a real backend token that must live server-side regardless — that lookup is unavoidable either way, so JWT's main advantage (skip the lookup) doesn't really apply. Given that, instant revocability of live backend credentials matters more than statelessness, so: opaque token, with everything meaningful (including expiry) authoritative in server-side storage.

## Refresh token handling

- Stored alongside the access token in the same session record.
- **Trigger strategy**: proactive check against `expiresAt` before calling the backend (refresh a little before expiry, invisible latency cost), *plus* a reactive one-shot refresh-and-retry if the backend still returns 401 despite a token that looked valid (clock skew, early revocation).
- `AuthProvider` gets an optional `refresh(session)` method — OAuth providers generally implement it; LDAP/AD/plain-login-without-refresh don't, and an expired session there just means a clean 401 asking the caller to log in again.
- **Refresh token rotation**: some providers issue a new refresh token on every use. The refresh handler must overwrite *both* the stored access and refresh tokens, or the next refresh silently fails against an already-invalidated token.
- **Concurrent-refresh stampede**: multiple near-simultaneous requests for the same expiring session must not each fire their own refresh call (especially dangerous with rotating refresh tokens). Needs a per-session lock — in-process for a single instance, distributed (see below) for multiple.
- **Persistence tradeoff**: in-memory-only sessions mean every restart forces every user to fully re-authenticate, even with a perfectly valid refresh token sitting there. Persisting sessions (encrypted at rest) avoids that at the cost of needing a shared encryption key and a real storage backend.

## Multi-instance / load balancing

In-memory session storage and an in-process lock both live inside one process's memory — neither survives a request for the same session landing on a different instance behind a load balancer.

**Decided: Redis is offered as a configurable option at the server level** — not mandatory, a deployment choice. This confirms the pluggable interface (`get`/`set`/`delete`/`tryLock`) with two implementations: in-memory `Map` (default, single-instance/dev) and Redis (opt in, required once there's more than one instance, or whenever surviving a restart without forcing re-login matters even for a single instance). Why Redis specifically fits well:

- Native key TTL matching `expiresAt` means expired sessions vanish on their own — no cleanup sweep to write or coordinate across instances.
- `SET key value NX PX <ttl>` gives a simple, effective *distributed* lock for the refresh stampede — the same problem as above, just now spanning processes instead of just concurrent requests within one.
- The OAuth Authorization Code pending-flow state has this same requirement, more urgently — the initiation and callback requests are two separate HTTP requests all but guaranteed to hit different instances.

**Sticky sessions** (routing a caller consistently to one instance) were considered as an alternative that avoids new infrastructure, but rejected as the default: an instance restart or crash loses every session pinned to it with no graceful failover, it fights the actual point of load balancing, and it doesn't fully solve the stampede problem for a single sticky client's own concurrent requests.

**Don't forget**: if backend tokens are encrypted at rest, every instance needs the *same* encryption key — it can't be generated per-instance at startup, or instance B can't decrypt what instance A wrote. Provision it like any other shared secret (env var identical across instances, or a real secrets manager).

Two follow-on questions that "Redis as a server-level option" raises:

- **One switch or several?** Sessions, the refresh lock, the OAuth pending-flow state, and the optional response cache (below) all have the same "needs to be shared" need. Recommend a single server-level toggle (e.g. `SESSION_STORE=memory|redis` + one `REDIS_URL`) that all four ride on together, rather than separate configuration for each — simpler to operate, one thing to provision and monitor. Open to a different answer if there's a reason to split them.
- **What happens if Redis is configured but unreachable at runtime?** Recommend failing closed — reject auth-gated requests with a clear 503-style error — rather than silently falling back to an in-memory store, which would leave different instances quietly disagreeing about who's logged in.

## Using Redis for more than tokens: session-scoped caching

Two different shapes worth keeping separate:

1. **Claims captured once at login.** An OAuth ID token, an LDAP attribute lookup, or a SAML assertion often carries more than just a token — department, role, group membership. Reuse the existing JSONPath-based `output.fields` extraction engine to pull named claims out of the login response and cache them in the session, exposed to backend configs via the same `{param}` substitution mechanism (possibly needing a small placeholder-syntax addition for dotted/namespaced names, or a flat naming convention to avoid colliding with declared `input` params).

   **Caveat, and it's a real one, not just a performance nuance**: a cached claim can go stale mid-session if the real directory changes (e.g., a revoked role). For anything authorization-relevant, keep the TTL short or tie claim refresh to the same cycle as token refresh, rather than caching indefinitely.

2. **A general, opt-in per-endpoint response cache.** Memoize an expensive backend call's result for a configurable TTL, keyed by a `{param}`-templated cache key (e.g. `customer:{id}`) that the endpoint author defines. Recommend:
   - **Off by default, opt-in per endpoint** — consistent with this app's fully declarative, nothing-implicit config philosophy; caching is exactly the kind of feature that causes real correctness bugs when applied silently.
   - **Its own Redis keyspace, separate from the auth session hash** — different lifecycle (an endpoint's chosen TTL vs. the session's token-driven expiry), and the cache key should only include the caller's identity when the data is actually caller-specific (a personal profile) — not when it's the same for everyone (reference/catalog data), where session-scoping would just waste cache slots.
   - **TTL-only expiry for v1** — no automatic "invalidate on a related write" logic. General cache invalidation is a famously hard problem; a predictable "stale for at most N seconds" contract beats a half-working automatic one.

Side benefit worth naming: because the cache lives in the same shared Redis all instances already talk to, there's no per-instance cache split-brain (instance A serving one stale value while instance B serves another) — a problem local in-process caching would otherwise reintroduce in exactly the load-balanced setup this is meant for.

## Suggested phased build order

1. **Built — see `README.md`'s "Caller authentication".** Generic backend-login + OAuth password/client_credentials grants — shares almost all its machinery, highest value for lowest complexity.
2. **Built — see `README.md`'s "Caller authentication".** LDAP/AD bind (plain simple-bind); Kerberos/SSO remains deferred to a later phase. Implemented as `kind: ldap` in `config/authProviders.yaml` (`src/auth/providers/ldap.ts`), supporting both a direct-bind mode (`userDnTemplate`) and a search-then-bind mode (`bindDn`/`bindPassword`/`searchBase`/`searchFilter` — the realistic AD/enterprise pattern), plus optional group-membership lookup and extra attribute capture. Since LDAP has no native token to relay, it mints its own signed JWT as the stand-in backend token (see "Decided" below and the doc comment on `LdapProviderConfig` in `src/types/config.ts`). A free local test directory (seeded users/groups, no external dependency) is available to build/test against — see `docker/openldap/README.md` — mirrored by an in-process fake LDAP server (`src/mock-backend/ldapServer.ts`) the automated test suite uses instead of depending on Docker.
3. **Built.** OAuth Authorization Code — the redirect flow. Implemented as `kind: oauth2`, `grantType: authorizationCode` (a third grant value on the *existing* oauth2 provider, not a new provider kind — the config shape is a natural extension even though the runtime flow is handled separately, see `src/auth/oauthCodeFlow.ts`'s doc comment). Three refinements versus this document's original framing, settled during implementation rather than left as open questions:
   - **No standalone `clients:` top-level registry.** The allow-list of trusted calling apps (`OAuthClientAppConfig` in `src/types/config.ts`) is nested under the *provider* itself (a `clients` field on the oauth2 config), not a separate top-level section — it's only ever checked at that one provider's own `/start` endpoint, and a real app registering separately with each identity provider it supports is exactly how OAuth already works. No new Console "Shared Collection" category needed: it's a kind/grant-specific field group on the existing Auth Provider editor.
   - **No Redis yet.** The pending-flow store (`src/auth/oauthPendingFlowStore.ts`) ships in-memory only for now, with the exact same single-instance/dev-only limitation `InMemorySessionStore` already has — deliberately not building Redis ahead of actual need. It remains a single future feature covering sessions+pending-state+cache together, as this document's "Multi-instance / load balancing" section already recommends.
   - **`openid-client`** (the recommended library below) handles PKCE, state, and the code exchange (`src/auth/oauthCodeFlow.ts`) — and validates an ID token's claims (`iss`, `aud`, `exp`) if a provider happens to return one. It does *not* verify the ID token's signature unless `enableNonRepudiationChecks()` is turned on, which it currently isn't; see "Authorization Code: what's built, plus planned changes" below.

   Two routes, exactly as designed: `GET /auth/oauth/:provider/start` and `GET /auth/oauth/:provider/callback` (`src/server/authRoutes.ts`), both outside the normal bearer-token gate. `AuthService.login()` was refactored to share its "mint an opaque token, store the session" bookkeeping with a new `completeOAuthLogin()` the callback route calls, so a session created via either path is identical from `resolveSession()`'s point of view — in particular, the standard `refresh_token` grant in `src/auth/providers/oauth2.ts` is reused unchanged regardless of which grant originally created the session. Demoable end to end against the mock backend: see `config/authProviders.yaml`'s `demoOAuthCode` and `.env.example`'s matching comment for the exact URL to open in a browser.
4. SAML — likely scoped to "accept an externally-obtained assertion" rather than a full SP, unless there's a specific need otherwise.

## Decided

- `requiresAuth` lives at the gateway level.
- Redis is offered as a configurable server-level option (not mandatory) for the session/lock/cache store.
- Active Directory is handled as plain LDAP bind for now; Kerberos/SSO is a later phase.
- The Authorization Code flow's end user is a human on a web or mobile application, not directly on this server — so the callback hands the token off via the calling app's `return_to`, not a page/cookie of our own.
- **OAuth client registration model**: this middleware itself is the one registered OAuth client with the real provider — it holds the client secret, does the full code exchange, and issues its own opaque session token to the calling web/mobile app. Client apps never see the real provider's tokens or credentials. This requires a lightweight registry of trusted calling apps (app id + allowed `return_to` destination(s)) so the final redirect can be checked against an allow-list rather than trusting whatever `return_to` a request claims — closing the open-redirect concern raised earlier.
- **App registry storage**: lives in config, the same file-based convention as `gateways`/`authProviders` (a new `clients:` section) — not console-UI-managed.
- **Mobile embedded surface**: both the system-browser pattern and an in-app WebView are documented for mobile developers, with the system browser as the recommended default (see the Client Integration Guide for the justification) and the WebView as a supported alternative for cases that specifically call for it.
- **Redis scope**: a single server-level toggle (e.g. `SESSION_STORE=memory|redis` + one `REDIS_URL`) covers sessions, the refresh lock, the OAuth pending-flow state, and the optional response cache uniformly — no per-feature configuration.
- **Redis outage behavior**: fail closed — if Redis is configured but unreachable at runtime, auth-gated requests are rejected (a clear 503-style error) rather than silently falling back to an in-memory store that different instances would disagree about.

## Client Integration Guide: OAuth Authorization Code via this middleware

This is the contract client-app developers (web or mobile) need, once an app is registered (see below).

**Roles**: this middleware is the OAuth client to the real identity provider (holds the client secret, never exposed to calling apps). A registered client app receives *this middleware's own opaque session token* at the end of the flow — never the real provider's tokens directly.

**Step 0 — one-time app registration (prerequisite).** Each client app must be registered with the middleware ahead of time: an app identifier, a display name, and one or more allowed `return_to` destinations — an exact HTTPS origin+path for a web app, or a custom URI scheme (`myapp://oauth-callback`) or, preferably, a claimed universal/app link for a mobile app (safer than a custom scheme, which more than one app on a device could in principle claim). This registry is what makes the allow-list check below meaningful rather than cosmetic.

**Step 1 — initiation.** The client app opens, in whatever browser surface it uses:
`GET {middleware}/auth/oauth/{provider}/start?app={appId}&return_to={one of the app's registered values}&state={app's own opaque pass-through value, optional}`
The middleware rejects this (400) unless `app`+`return_to` is an exact registered pair — no partial or wildcard matching. On success it generates its own internal `state` and PKCE pair for the exchange with the real provider (entirely separate from the app's own pass-through `state`), stores that pending-flow record, and redirects to the real provider's login page.

**Step 2 — the user authenticates** on the real provider's own page. Neither the middleware nor the client app can see what's entered there — see the note on embedded WebViews below for the one case where that guarantee weakens.

**Step 3 — the middleware's own callback** (never seen by the client app). The provider redirects to the middleware's registered callback URL; the middleware exchanges the code for tokens and creates the session exactly as designed earlier in this document.

**Step 4 — hand-off to the client app.** The middleware redirects the browser surface to the app's `return_to`, with its opaque session token attached — as a URL fragment where possible (fragments aren't sent to servers or captured in access logs, reducing accidental exposure) — plus the app's own pass-through `state` from step 1, so the app can correlate this response with the request that started it.

**Step 5 — what the client app does with it.**
- *Web app, popup pattern*: the page at `return_to` immediately `postMessage`s the token back to the window that opened the popup (verifying `event.origin`), then closes itself; the main app window holds the token and uses it as the bearer token on calls to the middleware's business endpoints.
- *Web app, full-page redirect*: simpler, no popup — `return_to` is just a normal page in the app that reads the token from the fragment and continues; the ordinary "Login with X" pattern most sites already use.
- *Mobile app*: the OS routes the custom-scheme/universal-link redirect straight back into the app, no server hop involved. Store the token in real secure storage (Keychain on iOS, Keystore-backed storage on Android) — never a plain preferences file.

**A note on "embedded," since it means two different things.** For the *web* app, an embedded popup window is the standard, safe version of this — ordinary browser context, normal cookies and same-origin behavior, nothing to be cautious about. One hard constraint worth knowing up front: an *iframe* generally will not work for this at all, since most real identity providers (Google, Microsoft, Okta, and others) explicitly block their login pages from being framed, as clickjacking protection on their end — so "embedded" for web should mean a popup, not an iframe.

For the *mobile* app, "embedded browser" more literally means a WebView built into the app's own screen. Two real options, both documented here so mobile developers know exactly what each entails — **system browser (`ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android) is the recommended default; an in-app WebView is documented as the supported alternative.**

- **System browser — recommended.** The OS presents the provider's login page in an isolated browser context that still overlays the app's own UI (it doesn't have to feel like "leaving the app"), but the app never has code-level access to that page's contents. Three concrete reasons this is the default recommendation, not just a stylistic preference:
  1. **It preserves the actual trust boundary OAuth exists to create.** The whole reason a provider issues a code back to *us*, rather than the app collecting a password directly, is so the app never sees the identity provider credential. An isolated system browser is what makes that guarantee real; a WebView the app hosts is code the app controls, and could in principle observe what's typed into it, intentionally or not.
  2. **It shares login state with the rest of the device.** A user already signed into the provider in their normal browser (or another app using this same pattern) can complete the flow without typing a password again — real SSO, not just a login screen that looks similar.
  3. **It's the only option guaranteed to work against every provider.** Google actively detects and blocks sign-in from common WebView user agents on its own accounts — a hard failure, not a style violation — and Apple's App Store review guidance leans toward the system-browser pattern for third-party login, which can create real review friction for a submitted app using an embedded WebView instead.
- **In-app WebView — supported alternative, not the default.** Fully embedded within the app's own screen, no OS browser chrome at all. Viable and sometimes chosen deliberately (e.g., a controlled internal-enterprise app where every provider involved is known not to block WebViews, or a strict UI requirement to never show any browser chrome), but it carries all three costs above, and needs re-evaluating per provider — some may work fine, at least one major provider (Google) will not.

Nothing about the middleware's side of the contract above changes based on this choice — `/start` → provider → our callback → redirect to `return_to` is identical either way, since the middleware never knows or cares which surface displayed the provider's page. This is purely something each mobile app configures locally, and can revisit later without touching the middleware.

## Authorization Code: what's built, plus planned changes

Status: the flow described in the sections above is built (commit `c9f3996`). The decided changes below come from an October 2026 brainstorm. Most are now built (nonce, required ID token, signature verification, future-`iat` check, `pkce` option, fixed error codes); the "Implementation status" paragraph under "Decided changes" lists what is not. Nothing from that work is committed yet.

### Built today (before the October 2026 changes)

This subsection describes the code as it was at commit `c9f3996`. The changes made since are under "Decided changes" and its "Implementation status" paragraph.

- Routes `GET /auth/oauth/:provider/start` and `/callback` (`src/server/authRoutes.ts`), the flow logic in `src/auth/oauthCodeFlow.ts` on `openid-client`, and an in-memory pending-flow store (`src/auth/oauthPendingFlowStore.ts`).
- Provider metadata is built from config (`authorizationUrl`, `tokenUrl`, and an optional `issuer` that defaults to `tokenUrl`'s origin). There is no discovery. Client authentication is `client_secret_post`.
- PKCE: always S256, with no way to turn it off.
- Several providers already work side by side. Each pending flow records its provider name, and the callback rejects a flow whose provider differs from the one in the URL. The calling-app allow-list (`clients`) is per provider.
- Callback behavior:
  - Success redirects to `return_to#token=…`.
  - A provider-reported `error` redirects to `return_to` with `error` and `error_description` passed through.
  - A failed exchange redirects with `error=login_failed` and the error message as `error_description`.
  - A missing, unknown or expired `state` returns a 400 and does not redirect.
- ID tokens: the code exchange passes only the expected `state` and the PKCE verifier. If a provider returns an ID token, `openid-client` validates its claims (`iss` against the configured issuer, `aud`, `exp`), and the session's `subject` comes from `sub` when present. There is no `nonce` (none is sent or checked), an ID token is not required even when `openid` is requested, and the ID token's **signature is not verified**. `openid-client` verifies it only if `enableNonRepudiationChecks()` is called, which it isn't (and the hand-built provider metadata has no `jwks_uri`). The library's documentation says signature checks on a token received directly from the token endpoint over TLS are not mandatory, because TLS validates the issuer (OpenID Connect Core 3.1.3.7, step 6), which is why the check is opt-in there.
- Mock provider: `/oauth/authorize` and the `authorization_code` branch of `/oauth/token` in `src/mock-backend/index.ts`, including an S256 verifier check. It has no ID token, nonce, JWKS, second issuer or failure scenarios.
- Tests: the config schema, `AuthService.completeOAuthLogin` and the pending-flow store. Nothing exercises `/start`, `/callback` or the code exchange itself.

### Decided changes

**Implementation status (October 2026, uncommitted).** Built and covered by tests in `test/oauthCodeFlow.mock.test.ts`:

- `nonce`: generated at `/start` when the scope includes `openid`, stored in the pending flow, sent to the provider, and passed as `expectedNonce`. This also makes the library require an ID token, so a response with no `id_token` is rejected.
- Signature verification: `jwks_uri` is added to the provider metadata and `enableNonRepudiationChecks()` is called when `jwksUri` is configured. The schema requires `jwksUri` whenever the scope includes `openid`.
- `iat` in the future beyond the tolerance is rejected by naimix's own check (the library doesn't do this). The clock tolerance is a fixed 60 s, also given to the library.
- `pkce: S256 | off` (default `S256`).
- Failure codes: the callback sends only `access_denied`, `invalid_id_token`, `provider_unavailable` or `server_error`, with no `error_description`; detail goes to the server log. A provider `error` is mapped: `access_denied` stays, `temporarily_unavailable` / `server_error` become `provider_unavailable`, everything else becomes `server_error`. Token-endpoint OAuth errors such as `invalid_grant` become `server_error`.
- Already enforced by `openid-client`, kept as guard tests: expected alg (`none` and HS256 confusion rejected), `sub` present, unexpected or mismatched `nonce`, RFC 9207 `iss` parameter.

Not built: configurable `algorithms` (the library accepts RS256 only), configurable `clockToleranceSeconds`, an `error_id`, and any naimix-side check of `azp` or an empty `sub` (not verified whether the library covers them). The JWKS refetch-on-unknown-`kid` behavior is the library's; the rotation test passes, but the refetch cooldown was not checked. Known imprecision: the library reports several response problems under one generic code, and when `openid` is requested naimix reports all of them as `invalid_id_token`, including an RFC 9207 `iss` mismatch.

The decisions as made:

**ID token validation, all checks required.** On every code-flow login that returns an ID token, the callback verifies all of the following and creates no session unless every check passes:

1. Signature against the provider's JWKS, with an unknown `kid` triggering a bounded refetch. **Decided: signature verification stays required**, even though OIDC Core allows skipping it for a token received directly from the token endpoint. Mechanism: turn on `openid-client`'s `enableNonRepudiationChecks()` and give each provider a `jwksUri`. A consequence is that a provider whose `scope` includes `openid` must configure `jwksUri`, since the check can't run without it.
2. Algorithm allow-list per provider (default RS256, plus ES256 where configured). `alg: none` and HS* are always rejected.
3. `iss` equals the provider's configured issuer (exact match; already done by the library).
4. `aud` contains this middleware's `client_id` for that provider. When `aud` has more than one value, `azp` must equal `client_id`.
5. `exp` not past and `iat` not in the future, each with a small clock tolerance (default 60 s, configurable per provider).
6. `nonce` equals the value stored in the pending-flow record. New: generate it at `/start`, send it to the provider, store it in the pending flow, and pass it as `expectedNonce` (which also makes the library require an ID token).
7. `sub` present and non-empty.

Also required: if the `openid` scope was requested and the token response has no `id_token`, the login fails.

RFC 9207: if the callback carries an `iss` parameter, it must equal the provider's configured issuer (checked when present).

Out of v1: `at_hash` (the code flow receives the access token over a direct TLS back channel); `userinfo` (add only when a config asks for claims the ID token lacks, and then its `sub` must match the ID token's); `auth_time` / `acr` / `max_age`.

`state` remains the CSRF check on the callback request. `nonce` is the matching check on the ID token.

**Several providers at once.** Already supported (see above). Additions: the pending-flow record gains the `nonce`, and the provider config gains `jwksUri`, `algorithms`, `clockToleranceSeconds` and `pkce` (below). Verification keys are cached per provider.

**PKCE is a per-provider option.** `pkce: S256 | off`, default `S256` (OAuth 2.1 requires PKCE for all code flows). No `plain`. `off` is for older providers that reject the extra parameters; with it, `/start` sends no `code_challenge` and the exchange sends no `code_verifier`. There is no discovery-based guard (the provider's supported PKCE methods can't be read, because the metadata comes from config).

**Failures go back to the calling app with a code and no detail.** Any failure after a valid pending record is found redirects to `return_to#error=<code>&state=<the app's own state>`. This replaces today's pass-through of `error_description` and the `login_failed` code. Codes:

- `access_denied`: the user declined, or the provider returned an error.
- `invalid_id_token`: every validation failure above collapses into this, so callers can't probe which check failed.
- `provider_unavailable`: token endpoint 5xx, timeout, or malformed response.
- `server_error`: anything else.

An optional `error_id` can be added for matching log lines. Detail goes to server logs only. As today, a missing, unknown or expired `state` returns a plain error response with no redirect, because there is no verified `return_to` to redirect to, and redirecting anywhere would reopen the open-redirect hole the allow-list closes. Errors before the flow starts (an unregistered `app` / `return_to` pair) remain a 400.

**Library: stay on `openid-client`.** It is already integrated, and the earlier idea of verifying ID tokens with `jose` is dropped. A scratch check (October 2026, Node 22.22, TypeScript 5.9.3, this repo's CommonJS tsconfig) confirmed `openid-client`, `oauth4webapi` and `jose` all type-check, compile to `require()` and load through Node's `require(esm)`. This repo declares `node >=24`, which is newer than the version tested.

### Testing approach: the mock provider and the flow-level harness are built

**Built (October 2026): `src/mock-backend/oauthServer.ts`**, started with `startMockOAuthServer()` and checked by its own 51 self-tests in `test/oauthMockServer.test.ts`. It is a separate module beside the existing `/oauth/*` endpoints in `index.ts`, which are untouched and still serve `demoOAuth` and `demoOAuthCode`. It provides:

- Several issuers in one process (path-prefixed, e.g. `/issuerA`, `/issuerB`) for the cross-provider tests.
- RS256 ID tokens, a JWKS endpoint with key rotation, and `nonce` echo.
- A headless `/authorize` that auto-approves a user chosen by `login_hint`.
- A scenario API (for example: change an ID-token claim, sign with an unknown key, return a 5xx) and a request log, so tests can assert what naimix actually sent (`code_verifier`, `redirect_uri`, client authentication).
- It reads `Date.now()`, so vitest fake timers move naimix and the mock together.

**Admin UI (October 2026).** `npm run mock-oauth` runs the mock standalone (`src/mock-backend/oauthRun.ts`, default port 9100, override with `MOCK_OAUTH_PORT`) and serves a page at `/admin` for creating issuers, and adding clients and users to a running issuer. The page shows each issuer's authorize, token and JWKS URLs and a ready-to-paste naimix `authProviders.yaml` entry per client. A Requests panel on the same page shows what the server received (newest first, filterable by issuer, auto-refresh, clear), with client secrets and Authorization headers masked; the log is in memory and capped at 1000 entries when the admin UI is on. Scope is deliberately small: no edit or delete, nothing persisted (a restart clears it), no scenario or fault controls (those stay in code), no authentication (binds to 127.0.0.1). The API is covered by `test/oauthAdmin.test.ts`; the page's own script has only been syntax-checked, not exercised in a browser. Enable it in code with `startMockOAuthServer({ admin: true })`; the issuer id `admin` is reserved.

Tests drive naimix with supertest acting as the browser: `/start`, follow the `Location` to the mock, follow its redirect to `/callback`. Alongside the mock, an occasional run against a real provider in Docker (Keycloak or Soluto `oidc-server-mock`, next to `docker/openldap`) guards against the mock drifting from reality.

Off-the-shelf options were checked in October 2026 and none gives both strictness and fault injection: axa `oauth2-mock-server` has hooks for altering claims, responses and redirects but its docs say it validates no incoming requests; navikt `mock-oauth2-server` doesn't document PKCE or nonce handling and is JVM-oriented; Soluto `oidc-server-mock` is spec-faithful with per-client `RequirePkce` but can't forge bad tokens and defaults to an interactive login; panva `node-oidc-provider` is the strictest but can't mint bad tokens natively. If the mock passes roughly 400 lines or starts re-implementing spec rules, move the strict happy path to `node-oidc-provider` and keep only the fault-injection layer.

Test matrix. Every failing row also asserts that no session is created and that the caller is redirected with the right error code (except the state row, which asserts no redirect):

| Check | Should fail | Should pass |
|---|---|---|
| Signature | Signed by a key not in the JWKS; tampered payload; unknown `kid` that stays unknown | Unknown `kid` that appears after a JWKS refetch (rotation) |
| Algorithm | `alg: none`; HS256 signed with the public key | The provider's configured algorithm |
| `iss` | Different issuer | Exact match |
| `aud` / `azp` | `client_id` absent; multi-value `aud` with a missing or wrong `azp` | Single match; array with the correct `azp` |
| `exp` / `iat` | Expired beyond tolerance; `iat` in the future beyond tolerance | Expired within tolerance |
| `nonce` | Missing; mismatched | Matches |
| `sub` | Missing; empty | Present |
| Response shape | No `id_token` with `openid` scope | Happy path |
| PKCE | Wrong `code_verifier` (provider returns `invalid_grant`); provider requires PKCE but `pkce: off` | `S256` accepted; `off` against a provider that doesn't require it |
| Callback | `error=access_denied`; mismatched RFC 9207 `iss`; replayed code | |
| State | Missing, unknown or expired `state`: plain error, **no redirect** | Valid `state` |
| Multi-provider | ID token from issuer A at provider B's callback (`iss` mismatch); code from A at B's callback (record's provider differs from the URL's) | Each provider's own flow |
| Token endpoint | 5xx; timeout; malformed JSON, all mapped to `provider_unavailable` | |

**Harness (`test/oauthCodeFlow.mock.test.ts`).** Runs naimix's real router, service and `oauthCodeFlow.ts` against the mock. It was written first with 11 tests red on purpose, one or more per planned change; all 32 tests now pass, and two `it.todo` cover the open decisions. Writing the tests first showed that `openid-client` already enforced the expected alg, `sub`, the RFC 9207 `iss` parameter and an unexpected nonce claim, so those became guard tests and the work went to the real gaps. The test group names that begin "planned:" are the ones that were red.

### Planned changes: open

- The mock is about 540 lines of code (about 700 with comments and types), past the roughly 400 lines at which the testing section above says to consider moving the strict happy path to `node-oidc-provider`. A good part of it is protocol behavior a strict mock needs (PKCE verification, single-use codes, `redirect_uri` matching, refresh rotation) and typed scenario options. Revisit if it keeps growing.
- The flow-level harness exists. The older `middleware`, `dataPlane` and `opsConsole` tests still don't load (they import `src/server/endpointRegistry`, which commit `9e5db14` removed), and some `mapper`, `functionCompiler` and `functionRegistry` tests fail; all of that predates this work.
- Library capabilities, partly answered: it sets the clock tolerance (via client metadata), checks the RFC 9207 `iss` parameter, and enforces RS256. It does not reject a future `iat` (naimix checks that). Still unconfirmed: the JWKS refetch cooldown, whether `azp` and an empty `sub` are checked, and whether a different algorithm (ES256) can be allowed per provider.
- Provider quirks: exact `iss` matching reportedly breaks on providers that vary a trailing slash, and on Azure's multi-tenant `common` endpoint, whose tokens carry a tenant-specific issuer (both from memory, not verified). Decide whether `iss` needs a per-provider pattern or override before targeting those providers.
- Whether the RFC 9207 `iss` parameter should be required, not just checked when present, for providers known to send it.
- The callback deletes the pending flow before comparing its provider to the URL's, so a callback sent to the wrong provider consumes the legitimate flow. Decide whether to compare first.
- Split the `invalid_id_token` code from RFC 9207 `iss` mismatches if callers need to tell them apart (currently they share it).

## Open questions still needing a decision

The open items for the Authorization Code / OIDC work are listed under "Authorization Code: what's built, plus planned changes" → "Planned changes: open" above. Nothing else is open here — see `DEPLOYMENT_ARCHITECTURE_NOTES.md` for the related, broader brainstorm on separating the developer console from the running API instances in production, and how console-made changes (not just Redis-related ones) reach every instance.
