import axios from "axios";
import type { BasicLoginProviderConfig } from "../../types/config";
import { extractJsonPath, mapItem } from "../../transform/mapper";
import { AuthError } from "../../server/errors";
import type { AuthProvider, AuthResult } from "../types";

/**
 * Generic "POST credentials, get JSON back, pull the token out with
 * JSONPath" provider for a backend with its own bespoke login API. See
 * BasicLoginProviderConfig and AUTH_DESIGN_NOTES.md's "Simple username/
 * password" note -- this is deliberately the same POST-JSON/extract-with-
 * JSONPath mechanics the JSON connector and output mapper already use,
 * just applied to a login call instead of a data call.
 *
 * No `refresh` in this phase: a bespoke login API's refresh mechanism (if
 * any) varies too much to generalize the way a standard OAuth2 token
 * endpoint's does (see oauth2.ts, which does implement it). An expired
 * session against a basicLogin provider just means a clean 401 asking the
 * caller to log in again.
 */
export function createBasicLoginProvider(name: string, config: BasicLoginProviderConfig): AuthProvider {
  return {
    name,
    kind: "basicLogin",

    async login(credentials: Record<string, unknown>): Promise<AuthResult> {
      const username = credentials.username;
      const password = credentials.password;
      if (!username || !password) {
        throw new AuthError("username and password are required");
      }

      const body = {
        ...(config.staticFields ?? {}),
        [config.usernameField ?? "username"]: username,
        [config.passwordField ?? "password"]: password,
      };

      const response = await axios.request({
        url: config.loginUrl,
        method: config.method ?? "POST",
        headers: config.headers,
        data: body,
        validateStatus: () => true,
      });

      if (response.status >= 400) {
        throw new AuthError(`Login failed (backend returned HTTP ${response.status})`);
      }

      return extractAuthResult(response.data, config);
    },
  };
}

function extractAuthResult(data: unknown, config: BasicLoginProviderConfig): AuthResult {
  const backendToken = extractJsonPath(data, config.tokenPath);
  if (typeof backendToken !== "string" || backendToken.length === 0) {
    throw new AuthError(`Login response did not contain a token at "${config.tokenPath}"`);
  }

  const refreshTokenRaw = config.refreshTokenPath ? extractJsonPath(data, config.refreshTokenPath) : undefined;
  const expiresInRaw = config.expiresInPath ? extractJsonPath(data, config.expiresInPath) : undefined;
  const subjectRaw = config.subjectPath ? extractJsonPath(data, config.subjectPath) : undefined;
  const expiresAt = typeof expiresInRaw === "number" ? Date.now() + expiresInRaw * 1000 : undefined;
  const claims = config.claims && config.claims.length > 0 ? mapItem(data, config.claims) : undefined;

  return {
    backendToken,
    refreshToken: typeof refreshTokenRaw === "string" ? refreshTokenRaw : undefined,
    expiresAt,
    subject: typeof subjectRaw === "string" ? subjectRaw : undefined,
    claims,
  };
}
