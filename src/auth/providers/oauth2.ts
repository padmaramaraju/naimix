import axios from "axios";
import type { OAuth2ProviderConfig } from "../../types/config";
import { mapItem } from "../../transform/mapper";
import { AuthError } from "../../server/errors";
import type { AuthProvider, AuthResult, SessionRecord } from "../types";

/**
 * A standard OAuth2 token endpoint (RFC 6749): password grant (the end
 * user's own credentials, passed straight through to the real provider) or
 * client_credentials grant (this middleware authenticating as itself, no
 * end user involved). Request and response field names follow the spec
 * (grant_type/access_token/refresh_token/expires_in), so unlike
 * basicLogin.ts there's no per-backend field-name configuration needed.
 *
 * A third grant, authorizationCode, is also "oauth2" by kind but is NOT
 * handled through login() below at all -- it's a browser redirect flow
 * with no credentials to post, so it needs two separate HTTP requests
 * (GET /auth/oauth/:provider/start and /callback) instead of one. See
 * oauthCodeFlow.ts for that grant's implementation and AUTH_DESIGN_NOTES.md
 * for the full design. login() below throws a clear error if called for a
 * provider configured with that grant, rather than sending it a malformed
 * token request.
 *
 * Implements `refresh` via the standard refresh_token grant, since real
 * OAuth2 responses (password grant or an authorizationCode exchange)
 * commonly include a refresh_token. If a given provider doesn't return one,
 * AuthService's own refresh handling degrades gracefully (see
 * authService.ts) -- it isn't a hard requirement. This is reused as-is for
 * authorizationCode-originated sessions: a refresh_token grant request
 * looks identical regardless of which grant originally created the
 * session.
 */
export function createOAuth2Provider(name: string, config: OAuth2ProviderConfig): AuthProvider {
  return {
    name,
    kind: "oauth2",

    async login(credentials: Record<string, unknown>): Promise<AuthResult> {
      if (config.grantType === "authorizationCode") {
        // Not a fit for this one-shot "POST credentials, get a token back"
        // shape at all -- there's no credential to post, just a browser
        // redirect to the real provider's own login page. See
        // oauthCodeFlow.ts and GET /auth/oauth/:provider/start instead.
        // Guards against the console UI's auth-provider "Test" tab (which
        // calls login() directly) silently sending a malformed request to
        // the real token endpoint for this grant.
        throw new AuthError(
          'The authorizationCode grant can\'t be tested with a direct login call -- open "GET /auth/oauth/<provider>/start" ' +
            "(with a registered app's id/return_to) to try the real redirect flow instead."
        );
      }

      const form: Record<string, string> = {
        grant_type: config.grantType,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      };
      if (config.scope) form.scope = config.scope;

      if (config.grantType === "password") {
        const username = credentials.username;
        const password = credentials.password;
        if (!username || !password) {
          throw new AuthError("username and password are required for the password grant");
        }
        form.username = String(username);
        form.password = String(password);
      }

      return requestToken(config, form);
    },

    async refresh(session: SessionRecord): Promise<AuthResult> {
      if (!session.refreshToken) {
        throw new AuthError("No refresh token available for this session");
      }
      return requestToken(config, {
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
    },
  };
}

async function requestToken(config: OAuth2ProviderConfig, form: Record<string, string>): Promise<AuthResult> {
  const response = await axios.request({
    url: config.tokenUrl,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(config.headers ?? {}) },
    data: new URLSearchParams(form).toString(),
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const data = response.data as { error?: string; error_description?: string } | undefined;
    const message = data?.error_description ?? data?.error ?? `HTTP ${response.status}`;
    throw new AuthError(`OAuth token request failed: ${message}`);
  }

  const data = (response.data ?? {}) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new AuthError("OAuth token response did not include an access_token");
  }

  const expiresAt = typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined;
  const claims = config.claims && config.claims.length > 0 ? mapItem(data, config.claims) : undefined;

  return {
    backendToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt,
    claims,
  };
}
