import type { AuthProviderConfig } from "../types/config";
import type { AuthProvider } from "./types";
import { createBasicLoginProvider } from "./providers/basicLogin";
import { createOAuth2Provider } from "./providers/oauth2";
import { createLdapProvider } from "./providers/ldap";

/** Dispatches to the right provider implementation by `kind` -- the auth
 * equivalent of callBackend()'s dispatch per connector type. */
export function createAuthProvider(name: string, config: AuthProviderConfig): AuthProvider {
  switch (config.kind) {
    case "basicLogin":
      return createBasicLoginProvider(name, config);
    case "oauth2":
      return createOAuth2Provider(name, config);
    case "ldap":
      return createLdapProvider(name, config);
    default: {
      const exhaustive: never = config;
      throw new Error(`Unsupported auth provider kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
