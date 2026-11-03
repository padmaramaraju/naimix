import { describe, expect, it } from "vitest";
import { REDACTED, mergeUnchangedSecrets, redact } from "../src/server/secretRedaction";

describe("secret redaction: addresses are not secrets", () => {
  const provider = {
    kind: "oauth2",
    tokenUrl: "https://idp.example.com/oauth/token",
    authorizationUrl: "https://idp.example.com/authorize",
    jwksUri: "https://idp.example.com/jwks",
    tokenPath: "$.access_token",
    clientId: "naimix",
    clientSecret: "s3cret",
    bindPassword: "pw",
    tokenSecret: "ts",
  };

  it("shows tokenUrl and other endpoint addresses, still hides real secrets", () => {
    const out = redact(provider) as Record<string, unknown>;
    expect(out.tokenUrl).toBe(provider.tokenUrl);
    expect(out.authorizationUrl).toBe(provider.authorizationUrl);
    expect(out.jwksUri).toBe(provider.jwksUri);
    expect(out.tokenPath).toBe(provider.tokenPath);
    expect(out.clientSecret).toBe(REDACTED);
    expect(out.bindPassword).toBe(REDACTED);
    expect(out.tokenSecret).toBe(REDACTED);
  });

  it("treats a blank tokenUrl on edit as a real clear, but a blank secret as unchanged", () => {
    const merged = mergeUnchangedSecrets({ tokenUrl: "", clientSecret: "" }, provider) as Record<string, unknown>;
    expect(merged.tokenUrl).toBe("");
    expect(merged.clientSecret).toBe("s3cret");
  });
});
