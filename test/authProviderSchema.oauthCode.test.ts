import { describe, expect, it } from "vitest";
import { authProviderConfigSchema } from "../src/config/schema";

/**
 * Covers the new authorizationCode-grant cross-field rules added to
 * authProviderConfigSchema's superRefine for "oauth2" providers (see
 * AUTH_DESIGN_NOTES.md's "OAuth Authorization Code" section and the
 * matching doc comment on OAuth2ProviderConfig in src/types/config.ts).
 * password/client_credentials validation is unchanged and already
 * exercised indirectly elsewhere, so this focuses on exactly what's new:
 * authorizationUrl/redirectUri/clients required together for
 * authorizationCode, and rejected for the other two grants.
 */
describe("authProviderConfigSchema: oauth2 authorizationCode grant", () => {
  const base = {
    kind: "oauth2" as const,
    tokenUrl: "https://idp.example.com/token",
    clientId: "demo-client",
    clientSecret: "demo-secret",
  };

  it("accepts a fully-configured authorizationCode provider", () => {
    const result = authProviderConfigSchema.parse({
      ...base,
      grantType: "authorizationCode",
      authorizationUrl: "https://idp.example.com/authorize",
      redirectUri: "https://naimix.example.com/auth/oauth/myProvider/callback",
      clients: [{ id: "webApp", returnTo: ["https://app.example.com/done"] }],
    });
    expect(result).toMatchObject({ grantType: "authorizationCode" });
  });

  it("rejects authorizationCode with no authorizationUrl", () => {
    expect(() =>
      authProviderConfigSchema.parse({
        ...base,
        grantType: "authorizationCode",
        redirectUri: "https://naimix.example.com/auth/oauth/myProvider/callback",
        clients: [{ id: "webApp", returnTo: ["https://app.example.com/done"] }],
      })
    ).toThrow(/authorizationUrl/);
  });

  it("rejects authorizationCode with no redirectUri", () => {
    expect(() =>
      authProviderConfigSchema.parse({
        ...base,
        grantType: "authorizationCode",
        authorizationUrl: "https://idp.example.com/authorize",
        clients: [{ id: "webApp", returnTo: ["https://app.example.com/done"] }],
      })
    ).toThrow(/redirectUri/);
  });

  it("rejects authorizationCode with no registered clients", () => {
    expect(() =>
      authProviderConfigSchema.parse({
        ...base,
        grantType: "authorizationCode",
        authorizationUrl: "https://idp.example.com/authorize",
        redirectUri: "https://naimix.example.com/auth/oauth/myProvider/callback",
      })
    ).toThrow(/clients/);

    expect(() =>
      authProviderConfigSchema.parse({
        ...base,
        grantType: "authorizationCode",
        authorizationUrl: "https://idp.example.com/authorize",
        redirectUri: "https://naimix.example.com/auth/oauth/myProvider/callback",
        clients: [],
      })
    ).toThrow(/clients/);
  });

  it("rejects a client with no returnTo entries", () => {
    expect(() =>
      authProviderConfigSchema.parse({
        ...base,
        grantType: "authorizationCode",
        authorizationUrl: "https://idp.example.com/authorize",
        redirectUri: "https://naimix.example.com/auth/oauth/myProvider/callback",
        clients: [{ id: "webApp", returnTo: [] }],
      })
    ).toThrow();
  });

  it("still accepts a plain password-grant provider with none of the new fields", () => {
    const result = authProviderConfigSchema.parse({ ...base, grantType: "password" });
    expect(result).toMatchObject({ grantType: "password" });
  });

  it("still accepts a plain client_credentials-grant provider with none of the new fields", () => {
    const result = authProviderConfigSchema.parse({ ...base, grantType: "client_credentials" });
    expect(result).toMatchObject({ grantType: "client_credentials" });
  });

  it("rejects authorizationUrl/redirectUri/clients on a password-grant provider", () => {
    expect(() =>
      authProviderConfigSchema.parse({
        ...base,
        grantType: "password",
        authorizationUrl: "https://idp.example.com/authorize",
      })
    ).toThrow(/authorizationCode grant/);
  });
});
