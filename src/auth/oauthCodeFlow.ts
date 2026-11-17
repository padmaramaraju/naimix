import crypto from "node:crypto";
import * as client from "openid-client";
import type { OAuth2ProviderConfig } from "../types/config";
import { mapItem } from "../transform/mapper";
import { AuthError, ValidationError } from "../server/errors";
import type { AuthResult } from "./types";

/**
 * The Authorization Code grant's two steps -- building the redirect to the
 * real provider, and exchanging the code the provider hands back for a
 * token -- using `openid-client` (recommended over hand-rolling this in
 * AUTH_DESIGN_NOTES.md, mainly for correct PKCE/state handling). The library
 * only validates ID-token claims; the signature is verified because this
 * module calls `enableNonRepudiationChecks()` when a `jwksUri` is configured
 * (required whenever the `openid` scope is requested).
 *
 * Deliberately NOT implemented through the `AuthProvider` interface
 * (oauth2.ts's `login()`/`refresh()`): that shape is one synchronous call
 * given credentials, which doesn't fit a two-request browser redirect at
 * all. The new `/auth/oauth/:provider/start` and `/callback` routes
 * (authRoutes.ts) call the two functions below directly instead. Refresh is
 * the one piece that IS reused as-is: a standard refresh_token grant looks
 * identical regardless of which original grant created the session, so
 * AuthService.doRefresh() calling oauth2.ts's existing `refresh()` already
 * works for a session that started life here -- nothing new needed there.
 *
 * `openid-client`'s `Configuration` normally comes from discovery (fetching
 * a `.well-known/openid-configuration` document), which doesn't fit this
 * app's fully declarative, nothing-implicit config philosophy (and plenty
 * of real OAuth2-only providers don't expose one at all) -- so this builds
 * one manually from `authorizationUrl`/`tokenUrl`/`issuer` instead, every
 * time it's needed. That's deliberately not cached across requests: a
 * provider's config can change via the console UI at any moment (the same
 * "re-read on every call" convention createAuthProvider() already follows
 * for the simpler grants), and constructing this object does no network
 * I/O, so there's no real cost to rebuilding it each time.
 */

/** Allowed clock difference between naimix and a provider, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 60;

function buildOidcConfig(config: OAuth2ProviderConfig): client.Configuration {
  if (config.grantType !== "authorizationCode") {
    throw new ValidationError(`Provider is not configured for the authorizationCode grant (grantType is "${config.grantType}")`);
  }
  if (!config.authorizationUrl || !config.redirectUri) {
    throw new ValidationError("authorizationCode provider is missing authorizationUrl/redirectUri");
  }
  const issuer = config.issuer ?? new URL(config.tokenUrl).origin;
  const oidcConfig = new client.Configuration(
    {
      issuer,
      authorization_endpoint: config.authorizationUrl,
      token_endpoint: config.tokenUrl,
      ...(config.jwksUri ? { jwks_uri: config.jwksUri } : {}),
    },
    config.clientId,
    { [client.clockTolerance]: CLOCK_TOLERANCE_SECONDS },
    client.ClientSecretPost(config.clientSecret)
  );

  // Verify the ID token's signature against the provider's JWKS (the
  // library otherwise only validates claims). Keys are fetched and cached
  // by the library, with a refetch on an unknown kid.
  if (config.jwksUri) {
    client.enableNonRepudiationChecks(oidcConfig);
  }
  // openid-client refuses to talk to a non-HTTPS endpoint by default. Every
  // other gateway/provider in this codebase already supports plain
  // http://localhost for local dev/test (see config/gateways.yaml,
  // config/authProviders.yaml's other entries) -- a real deployment's
  // authorizationUrl/tokenUrl are HTTPS anyway, so this only ever relaxes
  // anything for exactly the same local-dev case, never for a real one.
  if (config.authorizationUrl.startsWith("http://") || config.tokenUrl.startsWith("http://")) {
    client.allowInsecureRequests(oidcConfig);
  }

  return oidcConfig;
}

/** The fixed set of failure codes the callback hands back to the calling
 * app. Detail (the provider's message, the library's message) is logged
 * server-side only and never reaches the app. */
export type OAuthFailureCode = "access_denied" | "invalid_id_token" | "provider_unavailable" | "server_error";

export class OAuthFlowError extends AuthError {
  constructor(
    public code: OAuthFailureCode,
    detail: string
  ) {
    super(detail);
    this.name = "OAuthFlowError";
  }
}

/** Maps an error reported by the provider on the authorization redirect
 * (`error=` param) to our fixed code set. */
export function codeForProviderError(providerError: string): OAuthFailureCode {
  if (providerError === "access_denied") return "access_denied";
  if (providerError === "temporarily_unavailable" || providerError === "server_error") return "provider_unavailable";
  return "server_error";
}

function classifyExchangeError(err: unknown, config: OAuth2ProviderConfig): OAuthFailureCode {
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string") {
    if (code.startsWith("OAUTH_JWT_")) return "invalid_id_token";
    // A response that failed structural validation: with `openid` requested
    // this is overwhelmingly a missing/ill-formed id_token or its header
    // (alg), so report it as such. Imprecise for an RFC 9207 `iss` mismatch.
    if (code === "OAUTH_INVALID_RESPONSE") {
      return config.scope?.split(/\s+/).includes("openid") ? "invalid_id_token" : "server_error";
    }
    if (code === "OAUTH_RESPONSE_IS_NOT_CONFORM" || code === "OAUTH_PARSE_ERROR") return "provider_unavailable";
  }
  return "server_error";
}

export interface AuthorizationRequest {
  /** Where to redirect the browser -- the real provider's authorization
   * endpoint, with our client_id/redirect_uri/scope/state/PKCE params. */
  redirectUrl: string;
  /** Our own internal state -- sent to the real provider (CSRF protection
   * on that leg) AND used as this flow's key in the pending-flow store.
   * NOT the calling app's own pass-through state (see PendingOAuthFlow). */
  state: string;
  /** PKCE code_verifier -- kept server-side in the pending-flow store,
   * never exposed to the browser, sent to the token endpoint at the
   * callback step alongside the code. */
  /** Undefined when the provider is configured with `pkce: off`. */
  codeVerifier?: string;
  /** OIDC nonce -- sent to the provider and kept server-side; the ID token
   * must echo it back. Only set when the `openid` scope is requested. */
  nonce?: string;
}

/** Step 1 of the flow: builds the redirect to the real provider's login
 * page. Always uses PKCE (S256) regardless of whether the provider is
 * known to support it -- harmless if unsupported, and recommended even for
 * a confidential client per AUTH_DESIGN_NOTES.md. */
export async function buildAuthorizationRequest(config: OAuth2ProviderConfig): Promise<AuthorizationRequest> {
  const oidc = buildOidcConfig(config);
  const usePkce = (config.pkce ?? "S256") !== "off";
  const codeVerifier = usePkce ? client.randomPKCECodeVerifier() : undefined;
  const state = crypto.randomBytes(32).toString("hex");

  const params: Record<string, string> = {
    redirect_uri: config.redirectUri!,
    state,
  };
  if (codeVerifier) {
    params.code_challenge = await client.calculatePKCECodeChallenge(codeVerifier);
    params.code_challenge_method = "S256";
  }
  if (config.scope) params.scope = config.scope;
  let nonce: string | undefined;
  if (config.scope?.split(/\s+/).includes("openid")) {
    nonce = client.randomNonce();
    params.nonce = nonce;
  }

  const url = client.buildAuthorizationUrl(oidc, params);
  return { redirectUrl: url.href, state, codeVerifier, nonce };
}

export interface CodeExchangeParams {
  /** The real provider's full callback query string, exactly as received
   * (code, state, or an error/error_description on failure). */
  incomingSearch: URLSearchParams;
  /** Our own internal state from the matching pending-flow record --
   * validated against what's actually in `incomingSearch` before anything
   * else happens. */
  expectedState: string;
  codeVerifier?: string;
  /** The nonce sent at /start, if any; the ID token must carry it. */
  expectedNonce?: string;
}

/** Step 2 of the flow: exchanges the code for tokens at the real
 * provider's token endpoint and returns the same AuthResult shape every
 * other provider kind produces, so AuthService treats a session created
 * this way identically to one created via login(). */
export async function exchangeAuthorizationCode(config: OAuth2ProviderConfig, params: CodeExchangeParams): Promise<AuthResult> {
  const oidc = buildOidcConfig(config);

  // authorizationCodeGrant derives the redirect_uri it sends to the token
  // endpoint from the URL it's given here (stripped of its query string),
  // NOT from any field on the Configuration object -- so this is built
  // from our OWN trusted, configured `redirectUri`, with only the real
  // incoming query string appended, rather than from the live request's
  // own protocol/host (unreliable behind a reverse proxy/load balancer
  // unless `trust proxy` is configured exactly right). That guarantees the
  // redirect_uri this step sends matches, byte-for-byte, the one `/start`
  // already sent to the real provider's authorization endpoint.
  const currentUrl = new URL(config.redirectUri!);
  currentUrl.search = params.incomingSearch.toString();

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
      expectedState: params.expectedState,
      pkceCodeVerifier: params.codeVerifier,
      expectedNonce: params.expectedNonce,
    });
  } catch (err) {
    throw new OAuthFlowError(
      classifyExchangeError(err, config),
      `OAuth authorization code exchange failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!tokens.access_token) {
    throw new OAuthFlowError("provider_unavailable", "OAuth token response did not include an access_token");
  }

  const expiresAt = typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
  const claims = config.claims && config.claims.length > 0 ? mapItem(tokens as unknown as Record<string, unknown>, config.claims) : undefined;

  // Only set if the provider happened to return an OIDC ID token (plain
  // OAuth2 providers commonly don't) -- see getValidatedIdTokenClaims in
  // oauth4webapi: its claims (including `sub`) are structurally validated
  // (exp/aud/iss) as part of the exchange above regardless of whether we
  // asked for one, so this is safe to read whenever it's present.
  const idTokenClaims = tokens.claims?.();
  // The library validates exp but not a future iat.
  if (typeof idTokenClaims?.iat === "number" && idTokenClaims.iat > Date.now() / 1000 + CLOCK_TOLERANCE_SECONDS) {
    throw new OAuthFlowError("invalid_id_token", "ID token iat is in the future");
  }
  const subject = typeof idTokenClaims?.sub === "string" ? idTokenClaims.sub : undefined;

  return {
    backendToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    subject,
    claims,
  };
}
