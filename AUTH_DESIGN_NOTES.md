# Authentication & Backend Token Exchange — Design Notes

**Status: brainstorm only — nothing described here has been implemented.** Captured for reference before any of this gets built.

## The problem

Add support for authenticating the callers of this middleware's own business endpoints (not the admin UI, which stays gated by `ADMIN_TOKEN` as it is today) against enterprise identity systems — OAuth, Active Directory, LDAP, SAML, or a plain username/password — and use that login to obtain a token from the actual backend system. The middleware should hold onto that backend token, hand the caller back its own opaque session token, and on every subsequent request resolve that opaque token back to the real backend token before calling out.

This splits into two concerns worth keeping distinct: verifying who the caller is (authentication), and custody of a backend-issued credential attached to outgoing calls on that caller's behalf (token exchange/injection). They have different lifetimes and different security postures, and neither should be confused with `ADMIN_TOKEN`, which protects a different audience (whoever configures this instance) entirely.

## Proposed architecture

- **`AuthProvider` abstraction**, parallel to how `callBackend()` already dispatches to a connector per backend type (json/xml/soap/sql). Each provider kind (oauth2, ldap, ad, saml, basicBackendLogin) implements the same shape: given credentials, produce a backend token (+ optional refresh token + expiry).
- **Config model**: a new `authProviders` section alongside `gateways`, using the same `${env.VAR}` convention gateway secrets already use — nothing new to remember about where secrets live or that they must stay out of the shared Git workspace.
- **Where the requirement lives — decided**: on the *gateway* (`requiresAuth: someProviderName`), not per-endpoint — a gateway represents one backend connection, and auth is a property of that connection, matching how `baseUrl`/`headers` already work.
- **Login/exchange flow**: new routes, e.g. `POST /auth/login/{providerName}`, separate from both `/admin/api/*` and the business endpoints. On success, store `{ backendToken, refreshToken?, expiresAt, providerName, subject }` keyed by a newly minted opaque token, return that opaque token to the caller.
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
   - **Open-redirect risk — `return_to` needs an allow-list.** Once the callback's last act is "redirect to whatever URL the initiation request said," that's a classic open-redirect vulnerability unless `return_to` is checked against a pre-registered set of allowed destinations per calling app. In effect, this middleware becomes a small OAuth-like broker with its own notion of "registered client apps" (a name, one or more allowed `return_to` patterns — an HTTPS origin for a web app, a custom scheme for a mobile app), separate from and much lighter than the *real* provider's own client registration. Worth deciding whether that registry lives in config (a new `clients:` section) or needs an admin-UI-managed store.

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
3. OAuth Authorization Code — the redirect flow, once the client-registration and mobile-redirect questions below are answered.
4. SAML — likely scoped to "accept an externally-obtained assertion" rather than a full SP, unless there's a specific need otherwise.

## Decided

- `requiresAuth` lives at the gateway level.
- Redis is offered as a configurable server-level option (not mandatory) for the session/lock/cache store.
- Active Directory is handled as plain LDAP bind for now; Kerberos/SSO is a later phase.
- The Authorization Code flow's end user is a human on a web or mobile application, not directly on this server — so the callback hands the token off via the calling app's `return_to`, not a page/cookie of our own.
- **OAuth client registration model**: this middleware itself is the one registered OAuth client with the real provider — it holds the client secret, does the full code exchange, and issues its own opaque session token to the calling web/mobile app. Client apps never see the real provider's tokens or credentials. This requires a lightweight registry of trusted calling apps (app id + allowed `return_to` destination(s)) so the final redirect can be checked against an allow-list rather than trusting whatever `return_to` a request claims — closing the open-redirect concern raised earlier.
- **App registry storage**: lives in config, the same file-based convention as `gateways`/`authProviders` (a new `clients:` section) — not admin-UI-managed.
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

## Open questions still needing a decision

None remaining for this document — see `DEPLOYMENT_ARCHITECTURE_NOTES.md` for the related, broader brainstorm on separating the admin console from the running API instances in production, and how admin-made changes (not just Redis-related ones) reach every instance.
