import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockOAuthServer, type MockOAuthServerHandle } from "../src/mock-backend/oauthServer";

let mock: MockOAuthServerHandle;
let admin: string;

beforeAll(async () => {
  mock = await startMockOAuthServer({ admin: true });
  admin = `${mock.baseUrl}/admin`;
});

afterAll(async () => {
  await mock.stop();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${admin}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as any };
}

const client = (over: Record<string, unknown> = {}) => ({
  clientId: "naimix",
  clientSecret: "s3cret",
  redirectUris: ["http://localhost:3000/cb"],
  ...over,
});

describe("admin UI and API", () => {
  it("is off unless the server is started with admin: true", async () => {
    const plain = await startMockOAuthServer();
    try {
      expect((await fetch(`${plain.baseUrl}/admin`)).status).toBe(404);
    } finally {
      await plain.stop();
    }
  });

  it("serves the page", async () => {
    const res = await fetch(admin);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Mock OAuth server");
  });

  it("creates an issuer that then answers on its own URLs, and lists it", async () => {
    const created = await call("POST", "/issuers", { id: "made-in-ui", clients: [client()] });
    expect(created.status).toBe(201);
    expect(created.body.issuer).toBe(`${mock.baseUrl}/made-in-ui`);
    expect(created.body.tokenEndpoint).toBe(`${mock.baseUrl}/made-in-ui/token`);
    expect(created.body.users[0].sub).toBe("mock-user-1"); // default user

    const jwks = await (await fetch(created.body.jwksUri)).json();
    expect(jwks.keys.length).toBeGreaterThan(0);
    const discovery = await (await fetch(created.body.discoveryUrl)).json();
    expect(discovery.issuer).toBe(created.body.issuer);

    const list = await call("GET", "/issuers");
    expect(list.body.map((i: any) => i.id)).toContain("made-in-ui");
  });

  it("uses the posted users, and the issParameter and pkce choices", async () => {
    const created = await call("POST", "/issuers", {
      id: "custom",
      issParameter: true,
      clients: [client({ pkce: "optional" })],
      users: [{ sub: "alice", email: "alice@mock.test", claims: { name: "Alice" } }],
    });
    expect(created.status).toBe(201);
    expect(created.body.issParameter).toBe(true);
    expect(created.body.clients[0].pkce).toBe("optional");
    expect(created.body.users.map((u: any) => u.sub)).toEqual(["alice"]);
  });

  it("adds a client and a user to a running issuer, and the new ones take effect", async () => {
    await call("POST", "/issuers", { id: "growing", clients: [client()] });
    const withClient = await call("POST", "/issuers/growing/clients", client({ clientId: "second", redirectUris: ["http://localhost:4000/cb"] }));
    expect(withClient.status).toBe(201);
    const withUser = await call("POST", "/issuers/growing/users", { sub: "bob", email: "bob@mock.test" });
    expect(withUser.status).toBe(201);
    expect(withUser.body.clients.map((c: any) => c.clientId)).toEqual(["naimix", "second"]);
    expect(withUser.body.users.map((u: any) => u.sub)).toEqual(["mock-user-1", "bob"]);

    // The new client is really known to /authorize: it redirects (headless login) rather than 400ing.
    const url = new URL(`${mock.baseUrl}/growing/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "second",
      redirect_uri: "http://localhost:4000/cb",
      state: "x",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      login_hint: "bob@mock.test",
    }).toString();
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
  });

  it.each([
    ["a missing id", { clients: [client()] }],
    ["an id with a slash", { id: "a/b", clients: [client()] }],
    ["the reserved id admin", { id: "admin", clients: [client()] }],
    ["no clients", { id: "noclients", clients: [] }],
    ["a client with no redirect URI", { id: "nouri", clients: [client({ redirectUris: [] })] }],
    ["a redirect URI that is not an absolute http(s) URL", { id: "baduri", clients: [client({ redirectUris: ["/relative"] })] }],
    ["an unknown pkce mode", { id: "badpkce", clients: [client({ pkce: "plain" })] }],
    ["duplicate client ids", { id: "dupclient", clients: [client(), client()] }],
    ["duplicate user subs", { id: "dupuser", clients: [client()], users: [{ sub: "a" }, { sub: "a" }] }],
  ])("rejects %s with a 400 and creates nothing", async (_label, body) => {
    const res = await call("POST", "/issuers", body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    const id = (body as any).id;
    if (id) expect(mock.issuers().some((i) => i.id === id)).toBe(false);
  });

  it("answers 409 for an issuer id, client id or user sub that already exists", async () => {
    await call("POST", "/issuers", { id: "dups", clients: [client()] });
    expect((await call("POST", "/issuers", { id: "dups", clients: [client()] })).status).toBe(409);
    expect((await call("POST", "/issuers/dups/clients", client())).status).toBe(409);
    expect((await call("POST", "/issuers/dups/users", { sub: "mock-user-1" })).status).toBe(409);
  });

  it("answers 404 when adding to an unknown issuer, and 400 for a body that isn't JSON", async () => {
    expect((await call("POST", "/issuers/nope/clients", client())).status).toBe(404);
    const res = await fetch(`${admin}/api/issuers`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("refuses to add an issuer called admin from code too", () => {
    expect(() => mock.addIssuer("admin", { clients: [client() as any] })).toThrow(/reserved/);
  });

  describe("requests panel API", () => {
    const authorize = (id: string, extra: Record<string, string> = {}) => {
      const url = new URL(`${mock.baseUrl}/${id}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: "naimix",
        redirect_uri: "http://localhost:3000/cb",
        state: "s",
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        ...extra,
      }).toString();
      return fetch(url, { redirect: "manual" });
    };

    it("lists what the server received, newest first, filtered by issuer", async () => {
      await call("POST", "/issuers", { id: "logA", clients: [client()] });
      await call("POST", "/issuers", { id: "logB", clients: [client()] });
      await call("DELETE", "/requests");
      await authorize("logA", { state: "first" });
      await authorize("logB", { state: "second" });

      const all = await call("GET", "/requests");
      expect(all.body.total).toBe(2);
      expect(all.body.requests.map((r: any) => r.query.state)).toEqual(["second", "first"]);
      expect(all.body.requests[0]).toMatchObject({ issuerId: "logB", endpoint: "authorize", method: "GET" });

      const onlyA = await call("GET", "/requests?issuer=logA");
      expect(onlyA.body.requests.map((r: any) => r.query.state)).toEqual(["first"]);
    });

    it("masks client secrets and Authorization headers but shows the rest of a token request", async () => {
      await call("POST", "/issuers", { id: "logmask", clients: [client()] });
      await call("DELETE", "/requests");
      await fetch(`${mock.baseUrl}/logmask/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic c2VjcmV0" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: "nope", client_secret: "s3cret", code_verifier: "visible" }),
      });
      const row = (await call("GET", "/requests?issuer=logmask")).body.requests[0];
      expect(row.endpoint).toBe("token");
      expect(row.body.client_secret).toBe("***");
      expect(row.headers.authorization).toBe("***");
      expect(row.body.code_verifier).toBe("visible");
      expect(JSON.stringify(row)).not.toContain("s3cret");
    });

    it("clears the log, and does not record its own admin calls", async () => {
      await authorize("logA");
      expect((await call("DELETE", "/requests")).status).toBe(204);
      const after = await call("GET", "/requests");
      expect(after.body).toEqual({ total: 0, requests: [] });
    });
  });
});
