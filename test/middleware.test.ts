import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import { startMockBackend, type MockBackendHandle } from "../src/mock-backend";
import { startFakeLdapServer, type FakeLdapServerHandle } from "../src/mock-backend/ldapServer";
import { EndpointRegistry } from "../src/server/endpointRegistry";
import { GatewaysRegistry } from "../src/server/gatewaysRegistry";
import { AuthProvidersRegistry } from "../src/server/authProvidersRegistry";
import { createApp } from "../src/server/app";
import { closeAllSqlConnections } from "../src/connectors";
import { logger } from "../src/server/logger";

const MOCK_PORT = 5099;
const ADMIN_TOKEN = "test-admin-token";
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-test-"));
const TMP_ENDPOINTS_DIR = path.join(TMP_DIR, "endpoints");
const TMP_GATEWAYS_FILE = path.join(TMP_DIR, "gateways.yaml");
const TMP_AUTH_PROVIDERS_FILE = path.join(TMP_DIR, "authProviders.yaml");
const SQLITE_PATH = path.join(TMP_DIR, "demo.sqlite");
// Matches config/endpoints' real file count -- bump this alongside adding/
// removing a fixture endpoint under config/endpoints/.
const ENDPOINT_COUNT = 9;

let mockBackend: MockBackendHandle;
let fakeLdapServer: FakeLdapServerHandle;
let app: Express;
let endpointRegistry: EndpointRegistry;
let gatewaysRegistry: GatewaysRegistry;
let authProvidersRegistry: AuthProvidersRegistry;

function authed(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

beforeAll(async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  // Point every {env.X} placeholder in config/*.yaml at this test's mock
  // backend/DB before the config files are loaded.
  process.env.DEMO_JSON_BASE_URL = `http://localhost:${MOCK_PORT}`;
  process.env.DEMO_XML_BASE_URL = `http://localhost:${MOCK_PORT}`;
  process.env.DEMO_SOAP_WSDL_URL = `http://localhost:${MOCK_PORT}/soap?wsdl`;
  process.env.DEMO_SQLITE_PATH = SQLITE_PATH;
  process.env.DEMO_OAUTH_CLIENT_SECRET = "demo-secret";

  mockBackend = await startMockBackend(MOCK_PORT, SQLITE_PATH);

  // In-process fake LDAP server (see src/mock-backend/ldapServer.ts) --
  // the demoLdap auth provider's DEMO_LDAP_* env vars point at it, same
  // convention as the JSON/XML/SOAP/SQL mock backend above.
  fakeLdapServer = await startFakeLdapServer();
  process.env.DEMO_LDAP_URL = fakeLdapServer.url;
  process.env.DEMO_LDAP_BIND_PASSWORD = "adminpw123";
  process.env.DEMO_LDAP_TOKEN_SECRET = "test-ldap-token-secret";

  // Work off a disposable COPY of the real config, never the project's own
  // config/endpoints, config/gateways.yaml and config/authProviders.yaml --
  // the admin API tests below create/edit/delete files, which must never
  // touch the real project.
  fs.cpSync(path.resolve(__dirname, "../config/endpoints"), TMP_ENDPOINTS_DIR, { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../config/gateways.yaml"), TMP_GATEWAYS_FILE);
  fs.cpSync(path.resolve(__dirname, "../config/authProviders.yaml"), TMP_AUTH_PROVIDERS_FILE);

  endpointRegistry = new EndpointRegistry(TMP_ENDPOINTS_DIR);
  gatewaysRegistry = new GatewaysRegistry(TMP_GATEWAYS_FILE);
  authProvidersRegistry = new AuthProvidersRegistry(TMP_AUTH_PROVIDERS_FILE);
  const { errors } = endpointRegistry.reloadFromDisk();
  expect(errors, `endpoint config errors: ${JSON.stringify(errors)}`).toHaveLength(0);

  app = createApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger });
});

afterAll(async () => {
  await mockBackend.stop();
  await fakeLdapServer.stop();
  await closeAllSqlConnections();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("health & introspection", () => {
  it("reports healthy with all endpoints loaded", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.endpointCount).toBe(ENDPOINT_COUNT);
  });

  it("lists configured endpoints", async () => {
    const res = await request(app).get("/__endpoints");
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "json-customer-by-id",
        "json-customers-list",
        "xml-customer-by-id",
        "xml-customers-list",
        "soap-customer-by-id",
        "sql-customer-by-id",
        "sql-customers-list",
        "json-authed-echo",
        "ldap-authed-echo",
      ])
    );
  });
});

describe("JSON backend", () => {
  it("maps a single customer", async () => {
    const res = await request(app).get("/api/json/customers/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: "1",
      name: { first: "Ada", last: "Lovelace" },
      location: { city: "London", country: "UK" },
      isActive: "ACTIVE",
    });
  });

  it("propagates a 404 from the backend", async () => {
    const res = await request(app).get("/api/json/customers/999");
    expect(res.status).toBe(404);
  });

  it("maps a list response via output.root", async () => {
    const res = await request(app).get("/api/json/customers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toEqual({ id: "1", name: "Ada", city: "London" });
  });
});

describe("XML backend", () => {
  it("parses XML and maps nested fields", async () => {
    const res = await request(app).get("/api/xml/customers/2");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: "2",
      name: { first: "Grace", last: "Hopper" },
      location: { city: "New York", country: "USA" },
      status: "active", // transform: lower
    });
  });

  it("maps a collection response via output.root", async () => {
    const res = await request(app).get("/api/xml/customers");
    expect(res.status).toBe(200);
    // Text values come back exactly as written in the XML (parseTagValue:
    // false in connectors/xml.ts) -- same string ids as the JSON/SQL
    // backends, not auto-guessed into numbers. See TECHNICAL.md's "Output
    // mapping" section for why: fast-xml-parser's default guessing would
    // silently corrupt anything that merely looks numeric but isn't (e.g.
    // a zero-padded id like "007").
    expect(res.body).toEqual([
      { id: "1", name: "Ada", status: "ACTIVE" },
      { id: "2", name: "Grace", status: "ACTIVE" },
      { id: "3", name: "Alan", status: "INACTIVE" },
    ]);
  });
});

describe("SOAP backend", () => {
  it("calls the WSDL operation and maps the result", async () => {
    const res = await request(app).get("/api/soap/customers/3");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: "3",
      name: { first: "Alan", last: "Turing" },
      location: { city: "Manchester" },
    });
  });
});

describe("SQL backend", () => {
  it("runs a parameterized query and maps a single row", async () => {
    const res = await request(app).get("/api/sql/customers/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: "1",
      name: { first: "Ada", last: "Lovelace" },
      location: { city: "London" },
      active: "ACTIVE",
    });
  });

  it("maps every row via output.root for a list endpoint", async () => {
    const res = await request(app).get("/api/sql/customers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "1", name: "Ada", status: "ACTIVE" },
      { id: "2", name: "Grace", status: "ACTIVE" },
      { id: "3", name: "Alan", status: "INACTIVE" },
    ]);
  });
});

describe("unknown endpoints", () => {
  it("returns 404 for a path with no matching endpoint config", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("admin API auth", () => {
  it("rejects requests with no token", async () => {
    const res = await request(app).get("/admin/api/endpoints");
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const res = await request(app).get("/admin/api/endpoints").set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("accepts requests with the right token", async () => {
    const res = await request(app).get("/admin/api/endpoints").set(authed());
    expect(res.status).toBe(200);
  });
});

describe("admin API: endpoint CRUD takes effect immediately (no restart)", () => {
  const newEndpoint = {
    id: "admin-created-endpoint",
    description: "Created via the admin API in a test",
    method: "GET",
    path: "/api/admin-test/customers/:id",
    input: [{ name: "id", in: "path", required: true, type: "string" }],
    backend: { type: "json", gateway: "crmJson", url: "/customers/{id}", method: "GET" },
    output: { fields: [{ target: "id", source: "$.id" }, { target: "name", source: "$.firstName" }] },
  };

  it("404s before the endpoint is created", async () => {
    const res = await request(app).get("/api/admin-test/customers/1");
    expect(res.status).toBe(404);
  });

  it("creates an endpoint and it's immediately callable", async () => {
    const created = await request(app).post("/admin/api/endpoints").set(authed()).send(newEndpoint);
    expect(created.status).toBe(201);
    expect(created.body.endpoint.id).toBe("admin-created-endpoint");

    // No app restart, no re-require -- same `app` instance, next request.
    const called = await request(app).get("/api/admin-test/customers/1");
    expect(called.status).toBe(200);
    expect(called.body).toEqual({ id: "1", name: "Ada" });
  });

  it("persisted the endpoint to a YAML file on disk", () => {
    const file = endpointRegistry.getFile("admin-created-endpoint");
    expect(file).toBeDefined();
    expect(fs.existsSync(file!)).toBe(true);
  });

  it("rejects a second endpoint reusing the same id", async () => {
    const res = await request(app).post("/admin/api/endpoints").set(authed()).send(newEndpoint);
    expect(res.status).toBe(400);
  });

  it("rejects a second endpoint reusing the same method+path", async () => {
    const res = await request(app)
      .post("/admin/api/endpoints")
      .set(authed())
      .send({ ...newEndpoint, id: "admin-created-endpoint-2" });
    expect(res.status).toBe(400);
  });

  it("rejects a path missing the leading slash, with a field-scoped issue the UI can point at", async () => {
    const res = await request(app)
      .post("/admin/api/endpoints")
      .set(authed())
      .send({ ...newEndpoint, id: "admin-created-endpoint-3", path: "admin-test/customers/:id" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    // The admin UI (admin.js `api()`) reads `issues[].path` to say *which*
    // field is wrong -- keep this shape stable or that error message goes
    // back to being unattributed.
    const pathIssue = res.body.issues.find((i: { path: string[] }) => i.path.join(".") === "path");
    expect(pathIssue).toBeDefined();
    expect(pathIssue.message).toMatch(/start with/i);
  });

  it("updates the endpoint and the change is immediately live", async () => {
    const updated = {
      ...newEndpoint,
      output: { fields: [{ target: "customerId", source: "$.id" }] },
    };
    const res = await request(app).put("/admin/api/endpoints/admin-created-endpoint").set(authed()).send(updated);
    expect(res.status).toBe(200);

    const called = await request(app).get("/api/admin-test/customers/2");
    expect(called.body).toEqual({ customerId: "2" });
  });

  it("deletes the endpoint and it stops being callable", async () => {
    const del = await request(app).delete("/admin/api/endpoints/admin-created-endpoint").set(authed());
    expect(del.status).toBe(204);

    const called = await request(app).get("/api/admin-test/customers/1");
    expect(called.status).toBe(404);
  });
});

describe("endpoint config files are organized into folders mirroring each endpoint's path", () => {
  const folderEndpoint = {
    id: "folder-layout-list",
    method: "GET",
    path: "/api/folder-test/widgets/:id",
    input: [{ name: "id", in: "path", required: true, type: "string" }],
    backend: { type: "json", gateway: "crmJson", url: "/customers/{id}", method: "GET" },
    output: { fields: [{ target: "id", source: "$.id" }] },
  };

  it("creates the file under nested folders matching the path, with a bracketed param segment", async () => {
    const res = await request(app).post("/admin/api/endpoints").set(authed()).send(folderEndpoint);
    expect(res.status).toBe(201);

    const file = endpointRegistry.getFile("folder-layout-list");
    expect(file).toBeDefined();
    const relative = path.relative(TMP_ENDPOINTS_DIR, file!).split(path.sep);
    expect(relative).toEqual(["api", "folder-test", "widgets", "[id]", "folder-layout-list.yaml"]);
    expect(fs.existsSync(file!)).toBe(true);
  });

  it("puts a second endpoint on the SAME path into the same folder, as its own file", async () => {
    const res = await request(app)
      .post("/admin/api/endpoints")
      .set(authed())
      .send({ ...folderEndpoint, id: "folder-layout-update", method: "PUT" });
    expect(res.status).toBe(201);

    const listFile = endpointRegistry.getFile("folder-layout-list")!;
    const updateFile = endpointRegistry.getFile("folder-layout-update")!;
    expect(path.dirname(updateFile)).toBe(path.dirname(listFile));
    expect(updateFile).not.toBe(listFile);
  });

  it("moves the file when the path changes, but leaves a folder sibling endpoints still use", async () => {
    const oldFile = endpointRegistry.getFile("folder-layout-list")!;
    const oldDir = path.dirname(oldFile); // .../widgets/[id] -- folder-layout-update still lives here too

    const res = await request(app)
      .put("/admin/api/endpoints/folder-layout-list")
      .set(authed())
      .send({ ...folderEndpoint, path: "/api/folder-test/gadgets/:id" });
    expect(res.status).toBe(200);

    const newFile = endpointRegistry.getFile("folder-layout-list")!;
    expect(newFile).not.toBe(oldFile);
    expect(path.relative(TMP_ENDPOINTS_DIR, newFile).split(path.sep)).toEqual([
      "api",
      "folder-test",
      "gadgets",
      "[id]",
      "folder-layout-list.yaml",
    ]);
    expect(fs.existsSync(oldFile)).toBe(false);
    // "widgets/[id]" isn't pruned -- folder-layout-update (PUT, same old
    // path) is still on disk there, so the folder isn't actually empty.
    expect(fs.existsSync(oldDir)).toBe(true);
    expect(fs.existsSync(endpointRegistry.getFile("folder-layout-update")!)).toBe(true);
  });

  it("cleans up empty folders on delete too, once nothing else in them remains", async () => {
    const listDir = path.dirname(endpointRegistry.getFile("folder-layout-list")!); // .../gadgets/[id]
    const updateDir = path.dirname(endpointRegistry.getFile("folder-layout-update")!); // .../widgets/[id]
    expect(listDir).not.toBe(updateDir);

    await request(app).delete("/admin/api/endpoints/folder-layout-list").set(authed()).expect(204);
    expect(fs.existsSync(listDir)).toBe(false); // only file in "gadgets/[id]" -- pruned, "gadgets" too
    expect(fs.existsSync(path.dirname(listDir))).toBe(false);
    // "folder-test" survives: folder-layout-update is still under it.
    expect(fs.existsSync(path.join(TMP_ENDPOINTS_DIR, "api", "folder-test"))).toBe(true);

    await request(app).delete("/admin/api/endpoints/folder-layout-update").set(authed()).expect(204);
    expect(fs.existsSync(updateDir)).toBe(false);
    // Now nothing under "folder-test" remains at all -- pruned too. Other
    // endpoints under "api/" (the project's own fixtures, and the earlier
    // describe block's admin-created-endpoint) keep "api/" itself alive.
    expect(fs.existsSync(path.join(TMP_ENDPOINTS_DIR, "api", "folder-test"))).toBe(false);
    expect(fs.existsSync(TMP_ENDPOINTS_DIR)).toBe(true);
  });
});

describe("admin API: test-call endpoints", () => {
  it("test-backend fetches a raw sample without a saved endpoint", async () => {
    const res = await request(app)
      .post("/admin/api/test-backend")
      .set(authed())
      .send({
        input: [{ name: "id", in: "path", required: true, type: "string" }],
        backend: { type: "json", gateway: "crmJson", url: "/customers/{id}", method: "GET" },
        params: { id: "1" },
      });
    expect(res.status).toBe(200);
    expect(res.body.raw).toMatchObject({ id: "1", firstName: "Ada" });
  });

  it("test-mapping applies an output config to a supplied sample", async () => {
    const res = await request(app)
      .post("/admin/api/test-mapping")
      .set(authed())
      .send({
        raw: { id: "1", firstName: "Ada" },
        output: { fields: [{ target: "customerId", source: "$.id" }] },
      });
    expect(res.status).toBe(200);
    expect(res.body.mapped).toEqual({ customerId: "1" });
  });

  it("endpoints/:id/test runs a saved endpoint live", async () => {
    const res = await request(app)
      .post("/admin/api/endpoints/json-customer-by-id/test")
      .set(authed())
      .send({ params: { id: "3" } });
    expect(res.status).toBe(200);
    expect(res.body.mapped.customerId).toBe("3");
    expect(res.body.raw.id).toBe("3");
  });

  it("accepts a request body well over body-parser's 100kb default (MAX_REQUEST_BODY_SIZE)", async () => {
    // Regression check for "request entity too large": app.ts used to leave
    // express.json()'s `limit` unset, silently capping every request (data
    // endpoints and admin API alike) at body-parser's hardcoded 100kb
    // default. 200kb here is comfortably over that old ceiling and
    // comfortably under the new 10mb default.
    const big = "x".repeat(200 * 1024);
    const res = await request(app)
      .post("/admin/api/test-mapping")
      .set(authed())
      .send({
        raw: { id: "1", note: big },
        output: { fields: [{ target: "note", source: "$.note" }] },
      });
    expect(res.status).toBe(200);
    expect(res.body.mapped.note).toHaveLength(200 * 1024);
  });
});

describe("admin API: gateway CRUD", () => {
  it("creates a gateway", async () => {
    const res = await request(app)
      .post("/admin/api/gateways")
      .set(authed())
      .send({ name: "testGw", config: { kind: "json", baseUrl: "http://example.test" } });
    expect(res.status).toBe(201);
  });

  it("redacts a sensitive-looking literal field in list responses", async () => {
    await request(app)
      .post("/admin/api/gateways")
      .set(authed())
      .send({
        name: "secretGw",
        config: { kind: "sql", client: "better-sqlite3", connection: { filename: "x", password: "hunter2" } },
      });
    const res = await request(app).get("/admin/api/gateways").set(authed());
    expect(res.body.secretGw.connection.password).toBe("••••••••");
  });

  it("refuses to delete a gateway an endpoint still uses", async () => {
    const res = await request(app).delete("/admin/api/gateways/crmJson").set(authed());
    expect(res.status).toBe(409);
  });

  it("deletes an unused gateway", async () => {
    const res = await request(app).delete("/admin/api/gateways/testGw").set(authed());
    expect(res.status).toBe(204);
  });

  it("rejects a json gateway with no baseUrl, naming the field", async () => {
    const res = await request(app)
      .post("/admin/api/gateways")
      .set(authed())
      .send({ name: "noUrlGw", config: { kind: "json" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/baseUrl/);
  });

  it("rejects a soap gateway with no wsdl, naming the field", async () => {
    const res = await request(app)
      .post("/admin/api/gateways")
      .set(authed())
      .send({ name: "noWsdlGw", config: { kind: "soap" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/wsdl/);
  });
});

describe("caller auth: POST /auth/login + a gateway's requiresAuth", () => {
  it("rejects a call to an authed endpoint with no token", async () => {
    const res = await request(app).get("/api/authed/echo");
    expect(res.status).toBe(401);
  });

  it("rejects a call with an unknown/garbage token", async () => {
    const res = await request(app).get("/api/authed/echo").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("400s a login attempt against an unknown provider", async () => {
    const res = await request(app).post("/auth/login/doesNotExist").send({ username: "demo", password: "demo123" });
    expect(res.status).toBe(400);
  });

  it("rejects login with the wrong password", async () => {
    const res = await request(app).post("/auth/login/demoLogin").send({ username: "demo", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("logs in via basicLogin and uses the session token to call the authed endpoint", async () => {
    const login = await request(app)
      .post("/auth/login/demoLogin")
      .send({ username: "demo", password: "demo123" });
    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe("string");
    expect(login.body.expiresAt).toEqual(expect.any(Number));

    // The backend token demoLogin obtained (never seen by the caller) is
    // what actually reached the backend, injected via {__authToken} into
    // the gateway's own Authorization header config.
    const called = await request(app).get("/api/authed/echo").set("Authorization", `Bearer ${login.body.token}`);
    expect(called.status).toBe(200);
    expect(called.body.authHeaderSeenByBackend).toBe("Bearer mock-backend-token-for-demo");
  });

  it("rejects a session token issued by a different auth provider than the gateway requires", async () => {
    const login = await request(app)
      .post("/auth/login/demoOAuth")
      .send({ username: "demo", password: "demo123" });
    expect(login.status).toBe(200);

    // crmJsonAuthed's gateway requires "demoLogin", not "demoOAuth".
    const called = await request(app).get("/api/authed/echo").set("Authorization", `Bearer ${login.body.token}`);
    expect(called.status).toBe(401);
  });

  it("logs out, and the token stops working immediately (opaque tokens are instantly revocable)", async () => {
    const login = await request(app)
      .post("/auth/login/demoLogin")
      .send({ username: "demo", password: "demo123" });
    const logout = await request(app).post("/auth/logout").set("Authorization", `Bearer ${login.body.token}`);
    expect(logout.status).toBe(204);

    const called = await request(app).get("/api/authed/echo").set("Authorization", `Bearer ${login.body.token}`);
    expect(called.status).toBe(401);
  });

  describe("oauth2 provider, end to end through a gateway", () => {
    const gatewayName = "oauthTestGw";
    const endpointId = "oauth-test-echo";

    afterAll(async () => {
      await request(app).delete(`/admin/api/endpoints/${endpointId}`).set(authed());
      await request(app).delete(`/admin/api/gateways/${gatewayName}`).set(authed());
    });

    it("logs in via the password grant (real form-encoded RFC 6749 token exchange against the mock backend) and injects the resulting access token", async () => {
      const gw = await request(app)
        .post("/admin/api/gateways")
        .set(authed())
        .send({
          name: gatewayName,
          config: { kind: "json", baseUrl: "${env.DEMO_JSON_BASE_URL}", requiresAuth: "demoOAuth" },
        });
      expect(gw.status).toBe(201);

      const endpoint = await request(app)
        .post("/admin/api/endpoints")
        .set(authed())
        .send({
          id: endpointId,
          method: "GET",
          path: `/api/${gatewayName}/echo`,
          backend: {
            type: "json",
            gateway: gatewayName,
            url: "/echo",
            method: "GET",
            headers: { Authorization: "Bearer {__authToken}" },
          },
          output: { fields: [{ target: "authHeader", source: "$.headers.authorization" }] },
        });
      expect(endpoint.status).toBe(201);

      const login = await request(app)
        .post("/auth/login/demoOAuth")
        .send({ username: "demo", password: "demo123" });
      expect(login.status).toBe(200);

      const called = await request(app)
        .get(`/api/${gatewayName}/echo`)
        .set("Authorization", `Bearer ${login.body.token}`);
      expect(called.status).toBe(200);
      expect(called.body.authHeader).toMatch(/^Bearer mock-oauth-access-/);
    });
  });

  describe("ldap provider (search-then-bind), end to end through a gateway", () => {
    it("rejects login with the wrong password", async () => {
      const res = await request(app).post("/auth/login/demoLdap").send({ username: "jdoe", password: "wrong" });
      expect(res.status).toBe(401);
    });

    it("rejects login for a username not in the directory", async () => {
      const res = await request(app)
        .post("/auth/login/demoLdap")
        .send({ username: "nobody", password: "password123" });
      expect(res.status).toBe(401);
    });

    it("logs in via LDAP search-then-bind and uses the session token (the middleware's own signed stand-in JWT) to call the authed endpoint", async () => {
      const login = await request(app)
        .post("/auth/login/demoLdap")
        .send({ username: "jdoe", password: "password123" });
      expect(login.status).toBe(200);
      expect(typeof login.body.token).toBe("string");
      expect(login.body.expiresAt).toEqual(expect.any(Number));

      const called = await request(app)
        .get("/api/authed/ldap-echo")
        .set("Authorization", `Bearer ${login.body.token}`);
      expect(called.status).toBe(200);
      expect(called.body.authHeaderSeenByBackend).toMatch(/^Bearer /);

      // LDAP has no native token to relay, so the provider mints its own
      // signed JWT as the stand-in backend token -- decode it (this test
      // holds the same DEMO_LDAP_TOKEN_SECRET set in beforeAll) to check
      // the claims it's supposed to populate: subject DN, username, and
      // (via the demo provider's groupSearchBase/groupSearchFilter) group
      // membership resolved from the fake LDAP server's seed data.
      const backendToken = called.body.authHeaderSeenByBackend.replace(/^Bearer /, "");
      const decoded = jwt.verify(backendToken, "test-ldap-token-secret") as jwt.JwtPayload;
      expect(decoded.sub).toBe("uid=jdoe,ou=people,dc=naimix,dc=test");
      expect(decoded.username).toBe("jdoe");
      expect(decoded.groups).toEqual(expect.arrayContaining(["employees", "engineers"]));
    });

    it("rejects a session token issued by demoLdap against a gateway requiring a different provider", async () => {
      const login = await request(app)
        .post("/auth/login/demoLdap")
        .send({ username: "jdoe", password: "password123" });
      expect(login.status).toBe(200);

      // crmJsonAuthed's gateway requires "demoLogin", not "demoLdap".
      const called = await request(app).get("/api/authed/echo").set("Authorization", `Bearer ${login.body.token}`);
      expect(called.status).toBe(401);
    });
  });
});

describe("admin API: sessions (live view of the in-memory session store)", () => {
  it("lists no sessions when nobody is logged in", async () => {
    const res = await request(app).get("/admin/api/sessions").set(authed());
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("shows a session after login, with provider/subject/claims plus its real session/backend token outside production (this suite's own NODE_ENV)", async () => {
    const login = await request(app)
      .post("/auth/login/demoLogin")
      .send({ username: "demo", password: "demo123" });
    expect(login.status).toBe(200);

    const res = await request(app).get("/admin/api/sessions").set(authed());
    expect(res.status).toBe(200);
    const session = res.body.find((s: { providerName: string }) => s.providerName === "demoLogin");
    expect(session).toBeDefined();
    expect(session.subject).toBeTruthy();
    expect(typeof session.id).toBe("string");
    expect(session.id).not.toBe(login.body.token);
    expect(session.createdAt).toEqual(expect.any(Number));

    // vitest runs with NODE_ENV=test, not "production" -- AuthService's
    // isDevMode() gate (see authService.ts) treats that as non-production,
    // same as an ordinary local `npm run dev`, so these dev-only fields are
    // expected to be present here.
    expect(session.token).toBe(login.body.token);
    expect(session.backendToken).toBe("mock-backend-token-for-demo");

    // Clean up so this session doesn't leak into later tests in this block.
    await request(app).delete(`/admin/api/sessions/${session.id}`).set(authed());
  });

  it("withholds the session/backend/refresh tokens once NODE_ENV is exactly \"production\"", async () => {
    const login = await request(app)
      .post("/auth/login/demoLogin")
      .send({ username: "demo", password: "demo123" });
    expect(login.status).toBe(200);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let res;
    try {
      res = await request(app).get("/admin/api/sessions").set(authed());
    } finally {
      // Restore immediately so no later test in this file runs against a
      // "production" NODE_ENV by accident.
      process.env.NODE_ENV = previousNodeEnv;
    }
    expect(res.status).toBe(200);
    const session = res.body.find((s: { providerName: string }) => s.providerName === "demoLogin");
    expect(session).toBeDefined();
    // Still enough to identify and revoke the session...
    expect(session.subject).toBeTruthy();
    expect(typeof session.id).toBe("string");
    // ...but never the values a real production deployment must never leak.
    expect(session.token).toBeUndefined();
    expect(session.backendToken).toBeUndefined();
    expect(session.refreshToken).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(login.body.token);
    expect(JSON.stringify(session)).not.toContain("mock-backend-token-for-demo");

    await request(app).delete(`/admin/api/sessions/${session.id}`).set(authed());
  });

  it("revokes a session by id, and the caller's own token stops working immediately", async () => {
    const login = await request(app)
      .post("/auth/login/demoLogin")
      .send({ username: "demo", password: "demo123" });
    expect(login.status).toBe(200);

    const list = await request(app).get("/admin/api/sessions").set(authed());
    const session = list.body.find((s: { providerName: string }) => s.providerName === "demoLogin");
    expect(session).toBeDefined();

    const revoke = await request(app).delete(`/admin/api/sessions/${session.id}`).set(authed());
    expect(revoke.status).toBe(204);

    const called = await request(app).get("/api/authed/echo").set("Authorization", `Bearer ${login.body.token}`);
    expect(called.status).toBe(401);
  });

  it("404s revoking a session id that doesn't exist", async () => {
    const res = await request(app).delete("/admin/api/sessions/does-not-exist").set(authed());
    expect(res.status).toBe(404);
  });

  it("requires admin auth for both the list and revoke routes", async () => {
    const list = await request(app).get("/admin/api/sessions");
    expect(list.status).toBe(401);
    const revoke = await request(app).delete("/admin/api/sessions/whatever");
    expect(revoke.status).toBe(401);
  });
});

describe("admin API: auth-provider CRUD", () => {
  it("lists the demo auth providers", async () => {
    const res = await request(app).get("/admin/api/auth-providers").set(authed());
    expect(res.status).toBe(200);
    expect(res.body.demoLogin.kind).toBe("basicLogin");
    expect(res.body.demoOAuth.kind).toBe("oauth2");
    // demoOAuth's clientSecret is an ${env.X} reference, not a literal
    // value -- shown as-is, same convention as a gateway's own secrets (see
    // "redacts a sensitive-looking literal field" below for the literal case).
    expect(res.body.demoOAuth.clientSecret).toBe("${env.DEMO_OAUTH_CLIENT_SECRET}");
    // Regression check: a field ending in "Path" is a JSONPath expression,
    // not a secret, even though "tokenPath"/"refreshTokenPath" contain the
    // substring "token" that would otherwise trip the redaction pattern.
    expect(res.body.demoLogin.tokenPath).toBe("$.accessToken");
    expect(res.body.demoLogin.refreshTokenPath).toBe("$.refreshToken");
  });

  it("redacts a sensitive-looking literal field (a literal, non-${env.X} client secret)", async () => {
    await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({
        name: "literalSecretProvider",
        config: {
          kind: "oauth2",
          tokenUrl: "http://example.test/oauth/token",
          grantType: "client_credentials",
          clientId: "abc",
          clientSecret: "literal-secret-value",
        },
      });
    const res = await request(app).get("/admin/api/auth-providers").set(authed());
    expect(res.body.literalSecretProvider.clientSecret).toBe("••••••••");
    await request(app).delete("/admin/api/auth-providers/literalSecretProvider").set(authed());
  });

  it("creates an auth provider", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({
        name: "testProvider",
        config: { kind: "basicLogin", loginUrl: "http://example.test/login", tokenPath: "$.token" },
      });
    expect(res.status).toBe(201);
  });

  it("rejects a second provider reusing the same name", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({
        name: "testProvider",
        config: { kind: "basicLogin", loginUrl: "http://example.test/login", tokenPath: "$.token" },
      });
    expect(res.status).toBe(409);
  });

  it("rejects an oauth2 provider missing required fields, naming them", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({ name: "badOAuth", config: { kind: "oauth2", grantType: "client_credentials" } });
    expect(res.status).toBe(400);
    const paths = res.body.issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["tokenUrl", "clientId", "clientSecret"]));
  });

  it("rejects an ldap provider with neither bind mode fully configured", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({ name: "badLdap", config: { kind: "ldap", url: "ldap://localhost:3389", tokenSecret: "s" } });
    expect(res.status).toBe(400);
    const paths = res.body.issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toContain("userDnTemplate");
  });

  it("rejects an ldap provider with both bind modes configured (ambiguous)", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({
        name: "badLdap2",
        config: {
          kind: "ldap",
          url: "ldap://localhost:3389",
          userDnTemplate: "uid={username},ou=people,dc=naimix,dc=test",
          bindDn: "cn=admin,dc=naimix,dc=test",
          bindPassword: "adminpw123",
          searchBase: "ou=people,dc=naimix,dc=test",
          searchFilter: "(uid={username})",
          tokenSecret: "s",
        },
      });
    expect(res.status).toBe(400);
  });

  it("creates, updates and deletes an ldap provider (direct-bind mode)", async () => {
    const create = await request(app)
      .post("/admin/api/auth-providers")
      .set(authed())
      .send({
        name: "testLdapProvider",
        config: {
          kind: "ldap",
          url: "ldap://localhost:3389",
          userDnTemplate: "uid={username},ou=people,dc=naimix,dc=test",
          tokenSecret: "s",
        },
      });
    expect(create.status).toBe(201);

    const got = await request(app).get("/admin/api/auth-providers/testLdapProvider").set(authed());
    expect(got.body.kind).toBe("ldap");
    // Defaults filled in by the schema.
    expect(got.body.tlsRejectUnauthorized).toBe(true);
    expect(got.body.tokenTtlSeconds).toBe(3600);

    const update = await request(app)
      .put("/admin/api/auth-providers/testLdapProvider")
      .set(authed())
      .send({
        config: {
          kind: "ldap",
          url: "ldap://localhost:3389",
          userDnTemplate: "uid={username},ou=people,dc=naimix,dc=test",
          tokenSecret: "s",
          tokenTtlSeconds: 120,
        },
      });
    expect(update.status).toBe(200);

    const deleted = await request(app).delete("/admin/api/auth-providers/testLdapProvider").set(authed());
    expect(deleted.status).toBe(204);
  });

  it("updates an existing provider", async () => {
    const res = await request(app)
      .put("/admin/api/auth-providers/testProvider")
      .set(authed())
      .send({ config: { kind: "basicLogin", loginUrl: "http://example.test/login-v2", tokenPath: "$.token" } });
    expect(res.status).toBe(200);

    const got = await request(app).get("/admin/api/auth-providers/testProvider").set(authed());
    expect(got.body.loginUrl).toBe("http://example.test/login-v2");
  });

  it("refuses to delete a provider a gateway still requires", async () => {
    const res = await request(app).delete("/admin/api/auth-providers/demoLogin").set(authed());
    expect(res.status).toBe(409);
    expect(res.body.gateways).toContain("crmJsonAuthed");
  });

  it("deletes an unused provider", async () => {
    const res = await request(app).delete("/admin/api/auth-providers/testProvider").set(authed());
    expect(res.status).toBe(204);
  });
});

describe("admin API: test-connection (DB)", () => {
  it("reports ok for a reachable database", async () => {
    const res = await request(app)
      .post("/admin/api/gateways/test-connection")
      .set(authed())
      .send({
        config: {
          kind: "sql",
          client: "better-sqlite3",
          connection: { filename: SQLITE_PATH },
          useNullAsDefault: true,
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("reports a failure message for an unreachable database, without a 500", async () => {
    const res = await request(app)
      .post("/admin/api/gateways/test-connection")
      .set(authed())
      .send({
        config: {
          kind: "sql",
          client: "better-sqlite3",
          connection: { filename: "/definitely/does/not/exist/db.sqlite" },
          useNullAsDefault: true,
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.message).toBe("string");
  });

  it("says it's DB-only for a non-SQL gateway", async () => {
    const res = await request(app)
      .post("/admin/api/gateways/test-connection")
      .set(authed())
      .send({ config: { kind: "json", baseUrl: "http://example.test" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, message: expect.stringMatching(/SQL|database/i) });
  });
});

describe("admin API: auth-providers test-login", () => {
  // The admin UI always submits the FULL config the form currently shows
  // (built by the kind-specific _read(), same as Save would send) --
  // never a partial object -- so these mirror that: the real demoLogin/
  // demoLdap shape, with any sensitive field left blank standing in for
  // "the admin UI shows this field redacted/blank and didn't touch it".
  const demoLoginConfig = {
    kind: "basicLogin",
    loginUrl: "${env.DEMO_JSON_BASE_URL}/login",
    tokenPath: "$.accessToken",
    refreshTokenPath: "$.refreshToken",
    expiresInPath: "$.expiresIn",
  };
  const demoLdapConfig = {
    kind: "ldap",
    url: "${env.DEMO_LDAP_URL}",
    bindDn: "cn=admin,dc=naimix,dc=test",
    bindPassword: "", // blank -- should fall back to the stored ${env.DEMO_LDAP_BIND_PASSWORD} reference
    searchBase: "ou=people,dc=naimix,dc=test",
    searchFilter: "(uid={username})",
    groupSearchBase: "ou=groups,dc=naimix,dc=test",
    groupSearchFilter: "(member={dn})",
    attributes: ["mail", "title", "departmentNumber"],
    tokenSecret: "", // blank -- should fall back to the stored ${env.DEMO_LDAP_TOKEN_SECRET} reference
  };

  it("reports ok for a saved basicLogin provider, given the real demo credentials", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({ name: "demoLogin", config: demoLoginConfig, credentials: { username: "demo", password: "demo123" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("reports a failure message (not a 500) for wrong credentials against a saved provider", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({ name: "demoLogin", config: demoLoginConfig, credentials: { username: "demo", password: "wrong" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.message).toBe("string");
  });

  it("reuses the saved bindPassword and tokenSecret when a draft edit of demoLdap leaves them blank", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({ name: "demoLdap", config: demoLdapConfig, credentials: { username: "jdoe", password: "password123" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.subject).toBe("uid=jdoe,ou=people,dc=naimix,dc=test");
    expect(res.body.claims.groups).toEqual(expect.arrayContaining(["employees", "engineers"]));
  });

  it("tests an unsaved draft config directly, with no `name` and full (non-blank) fields", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({
        config: {
          kind: "ldap",
          url: fakeLdapServer.url,
          bindDn: "cn=admin,dc=naimix,dc=test",
          bindPassword: "adminpw123",
          searchBase: "ou=people,dc=naimix,dc=test",
          searchFilter: "(uid={username})",
          tokenSecret: "draft-token-secret",
        },
        credentials: { username: "jdoe", password: "password123" },
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.subject).toBe("uid=jdoe,ou=people,dc=naimix,dc=test");
  });

  it("reports a failure message for an unknown username against demoLdap", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({ name: "demoLdap", config: demoLdapConfig, credentials: { username: "nobody", password: "password123" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.message).toBe("string");
  });

  it("never creates a session -- the response carries no token a caller could use", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({ name: "demoLdap", config: demoLdapConfig, credentials: { username: "jdoe", password: "password123" } });
    expect(res.body.ok).toBe(true);
    // A real /auth/login call would have returned a bearer token; test-login
    // never does, since it's not meant to produce anything a caller could
    // use to reach an authed endpoint.
    expect(res.body.token).toBeUndefined();
    expect(res.body.backendToken).toBeUndefined();
  });

  it("rejects a malformed draft config the same way saving would (400 with field issues)", async () => {
    const res = await request(app)
      .post("/admin/api/auth-providers/test-login")
      .set(authed())
      .send({ config: { kind: "ldap", url: "ldap://localhost:3389", tokenSecret: "s" }, credentials: {} });
    expect(res.status).toBe(400);
    const paths = res.body.issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toContain("userDnTemplate");
  });
});

describe("gateway commonParams + env-sourced input params", () => {
  const endpointId = "admin-created-echo-endpoint";
  const gatewayName = "echoGw";

  afterAll(async () => {
    await request(app).delete(`/admin/api/endpoints/${endpointId}`).set(authed());
    await request(app).delete(`/admin/api/gateways/${gatewayName}`).set(authed());
  });

  it("merges a gateway's commonParams under, and an env-sourced input over, into the backend call", async () => {
    process.env.NAIMIX_TEST_USER = "u-42";

    const gw = await request(app)
      .post("/admin/api/gateways")
      .set(authed())
      .send({
        name: gatewayName,
        // Reuses the same ${env.X} substitution every gateway field already
        // gets -- commonParams needed no new plumbing for this.
        config: { kind: "json", baseUrl: "${env.DEMO_JSON_BASE_URL}", commonParams: { tenant: "acme" } },
      });
    expect(gw.status).toBe(201);

    const endpoint = await request(app)
      .post("/admin/api/endpoints")
      .set(authed())
      .send({
        id: endpointId,
        method: "GET",
        path: `/${gatewayName}/${endpointId}`,
        input: [
          { name: "userId", in: "env", envVar: "NAIMIX_TEST_USER", required: true },
          { name: "tenant", in: "query", required: false },
        ],
        backend: {
          type: "json",
          gateway: gatewayName,
          url: "/echo",
          method: "GET",
          query: { tenant: "{tenant}", user: "{userId}" },
        },
        output: {
          fields: [
            { target: "tenant", source: "$.query.tenant" },
            { target: "user", source: "$.query.user" },
          ],
        },
      });
    expect(endpoint.status).toBe(201);

    // No ?tenant= on the request -- falls back to the gateway's default.
    const usingDefault = await request(app).get(`/${gatewayName}/${endpointId}`);
    expect(usingDefault.status).toBe(200);
    expect(usingDefault.body).toEqual({ tenant: "acme", user: "u-42" });

    // A caller-supplied value for the same name overrides the gateway default.
    const overridden = await request(app).get(`/${gatewayName}/${endpointId}?tenant=override`);
    expect(overridden.status).toBe(200);
    expect(overridden.body).toEqual({ tenant: "override", user: "u-42" });
  });

  it("fails a required env-sourced param whose environment variable isn't set", async () => {
    delete process.env.NAIMIX_TEST_USER;
    const res = await request(app).get(`/${gatewayName}/${endpointId}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/userId/);
  });
});

describe("admin API: generate CRUD endpoints for a SQL gateway", () => {
  it("404s for a gateway that doesn't exist", async () => {
    const res = await request(app).post("/admin/api/gateways/doesNotExist/generate-crud").set(authed());
    expect(res.status).toBe(404);
  });

  it("400s for a non-SQL gateway", async () => {
    const res = await request(app).post("/admin/api/gateways/crmJson/generate-crud").set(authed());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/SQL|database/i);
  });

  it("introspects demoDb and generates list/create/update/delete for every table, skipping bulk ops on a table with no primary key", async () => {
    const res = await request(app).post("/admin/api/gateways/demoDb/generate-crud").set(authed());
    expect(res.status).toBe(200);
    expect(res.body.tablesFound).toBe(3);
    expect(res.body.proceduresFound).toBe(0);
    expect(res.body.proceduresSupported).toBe(false);

    const createdIds = res.body.created.map((r: { id: string }) => r.id).sort();
    expect(createdIds).toEqual(
      [
        "demoDb-customers-list",
        "demoDb-customers-create",
        "demoDb-customers-update",
        "demoDb-customers-delete",
        "demoDb-notes-list",
        "demoDb-notes-create",
        "demoDb-notes-update",
        "demoDb-notes-delete",
        "demoDb-tags-list",
        "demoDb-tags-create",
      ].sort()
    );
    // "tags" has no primary key -- update/delete endpoints were never attempted for it.
    expect(createdIds).not.toContain("demoDb-tags-update");
    expect(createdIds).not.toContain("demoDb-tags-delete");

    expect(res.body.skipped).toEqual([
      expect.objectContaining({ kind: "table", name: "tags", reason: expect.stringMatching(/no primary key/i) }),
    ]);

    // Every generated endpoint is immediately live and visible, same as any
    // endpoint created through the ordinary admin API.
    const endpoints = await request(app).get("/admin/api/endpoints").set(authed());
    expect(endpoints.body.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(createdIds));
  });

  it("re-running generation is idempotent: everything already created is skipped, nothing is duplicated", async () => {
    const res = await request(app).post("/admin/api/gateways/demoDb/generate-crud").set(authed());
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    // 9 id conflicts (every endpoint from the first run except the "tags"
    // pair, which also re-conflict) plus the recurring "no primary key" note
    // -- in practice every one of the 10 previously-created endpoints
    // conflicts on id, so all 10 are reported, plus the no-PK note for tags.
    expect(res.body.skipped.length).toBeGreaterThanOrEqual(10);
    expect(res.body.skipped.some((s: { reason: string }) => /already exists/.test(s.reason))).toBe(true);
  });

  it("the generated list endpoint returns real rows, filterable by column and by a comma-separated id list", async () => {
    const all = await request(app).get("/api/demoDb/customers");
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(3);
    expect(all.body[0]).toMatchObject({ id: "1", first_name: "Ada", status: "ACTIVE" });

    const filtered = await request(app).get("/api/demoDb/customers?status=INACTIVE");
    expect(filtered.status).toBe(200);
    expect(filtered.body.map((r: { id: string }) => r.id)).toEqual(["3"]);

    const byIds = await request(app).get("/api/demoDb/customers?ids=1,3");
    expect(byIds.status).toBe(200);
    expect(byIds.body.map((r: { id: string }) => r.id).sort()).toEqual(["1", "3"]);
  });

  it("bulk-creates multiple rows in a single request", async () => {
    const res = await request(app)
      .post("/api/demoDb/notes")
      .send({
        rows: [
          { customer_id: "3", body: "first bulk note" },
          { customer_id: "3", body: "second bulk note" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.insertedCount).toBe(2);

    const listed = await request(app).get("/api/demoDb/notes?customer_id=3");
    expect(listed.body).toHaveLength(2);
    expect(listed.body.map((n: { body: string }) => n.body).sort()).toEqual(["first bulk note", "second bulk note"]);
  });

  it("bulk-updates and bulk-deletes multiple rows by primary key in a single request each", async () => {
    const before = await request(app).get("/api/demoDb/notes?customer_id=3");
    const [noteA, noteB] = before.body as { note_id: number }[];

    const updated = await request(app)
      .patch("/api/demoDb/notes")
      .send({
        updates: [
          { key: { note_id: noteA.note_id }, fields: { body: "updated A" } },
          { key: { note_id: noteB.note_id }, fields: { body: "updated B" } },
        ],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.updatedCount).toBe(2);

    const afterUpdate = await request(app).get("/api/demoDb/notes?customer_id=3");
    expect(afterUpdate.body.map((n: { body: string }) => n.body).sort()).toEqual(["updated A", "updated B"]);

    const deleted = await request(app)
      .delete("/api/demoDb/notes")
      .send({ keys: [{ note_id: noteA.note_id }, { note_id: noteB.note_id }] });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedCount).toBe(2);

    const afterDelete = await request(app).get("/api/demoDb/notes?customer_id=3");
    expect(afterDelete.body).toEqual([]);
  });

  it("rejects malformed bulk request bodies with a clear 400 instead of a 500", async () => {
    const noRows = await request(app).post("/api/demoDb/notes").send({});
    expect(noRows.status).toBe(400);
    expect(noRows.body.message).toMatch(/rows/);

    const badKey = await request(app)
      .patch("/api/demoDb/notes")
      .send({ updates: [{ key: { wrongColumn: 1 }, fields: { body: "x" } }] });
    expect(badKey.status).toBe(400);
    expect(badKey.body.message).toMatch(/primary key/i);

    const emptyKeys = await request(app).delete("/api/demoDb/notes").send({ keys: [] });
    expect(emptyKeys.status).toBe(400);
    expect(emptyKeys.body.message).toMatch(/keys/);
  });
});

describe("admin API: generate CRUD endpoints -- skip-and-report on a path conflict", () => {
  const gatewayName = "demoDb2";

  afterAll(async () => {
    await request(app).delete(`/admin/api/endpoints/manual-${gatewayName}-customers-list`).set(authed());
    for (const suffix of ["customers-create", "customers-update", "customers-delete", "notes-list", "notes-create", "notes-update", "notes-delete", "tags-list", "tags-create"]) {
      await request(app).delete(`/admin/api/endpoints/${gatewayName}-${suffix}`).set(authed());
    }
    await request(app).delete(`/admin/api/gateways/${gatewayName}`).set(authed());
  });

  it("skips only the endpoint whose path collides with a hand-written one, and still creates everything else", async () => {
    const gw = await request(app)
      .post("/admin/api/gateways")
      .set(authed())
      .send({
        name: gatewayName,
        config: { kind: "sql", client: "better-sqlite3", connection: { filename: SQLITE_PATH }, useNullAsDefault: true },
      });
    expect(gw.status).toBe(201);

    // A hand-written endpoint already claims GET /api/demoDb2/customers under
    // a different id -- generation must not overwrite or duplicate it.
    const manual = await request(app)
      .post("/admin/api/endpoints")
      .set(authed())
      .send({
        id: `manual-${gatewayName}-customers-list`,
        method: "GET",
        path: `/api/${gatewayName}/customers`,
        backend: { type: "json", gateway: "crmJson", url: "/customers", method: "GET" },
        output: { fields: [{ target: "note", source: "$" }] },
      });
    expect(manual.status).toBe(201);

    const res = await request(app).post(`/admin/api/gateways/${gatewayName}/generate-crud`).set(authed());
    expect(res.status).toBe(200);

    const createdIds = res.body.created.map((r: { id: string }) => r.id);
    expect(createdIds).not.toContain(`${gatewayName}-customers-list`);
    expect(createdIds).toEqual(
      expect.arrayContaining([`${gatewayName}-customers-create`, `${gatewayName}-customers-update`, `${gatewayName}-customers-delete`])
    );

    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "table",
          name: "customers",
          reason: expect.stringMatching(new RegExp(`manual-${gatewayName}-customers-list`)),
        }),
      ])
    );

    // The hand-written endpoint is untouched and still answers as before.
    const stillManual = await request(app).get(`/api/${gatewayName}/customers`);
    expect(stillManual.status).toBe(200);
  });
});

// Each user runs their own instance against their own local Git checkout of
// endpoints/gateways (see README/TECHNICAL.md "Workspace"). This describe
// block builds a fully separate app + pair of registries so it can freely
// switch workspaces back and forth without ever touching the shared
// `app`/`endpointRegistry`/`gatewaysRegistry` the rest of this file depends
// on.
describe("admin API: workspace switching", () => {
  const WS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-ws-test-"));
  const FOLDER_A = path.join(WS_ROOT, "folder-a"); // populated: a copy of the real project config
  const FOLDER_B = path.join(WS_ROOT, "folder-b"); // exists, but starts empty -- a brand-new team repo
  const MISSING_FOLDER = path.join(WS_ROOT, "does-not-exist-yet");
  const WS_SETTINGS_FILE = path.join(WS_ROOT, "settings.json");

  let wsApp: Express;
  let wsEndpointRegistry: EndpointRegistry;
  let wsGatewaysRegistry: GatewaysRegistry;
  let wsAuthProvidersRegistry: AuthProvidersRegistry;
  const wsWorkspace: { configDir?: string } = { configDir: FOLDER_A };

  beforeAll(() => {
    fs.mkdirSync(path.join(FOLDER_A, "endpoints"), { recursive: true });
    fs.cpSync(path.resolve(__dirname, "../config/endpoints"), path.join(FOLDER_A, "endpoints"), { recursive: true });
    fs.cpSync(path.resolve(__dirname, "../config/gateways.yaml"), path.join(FOLDER_A, "gateways.yaml"));
    fs.cpSync(path.resolve(__dirname, "../config/authProviders.yaml"), path.join(FOLDER_A, "authProviders.yaml"));
    fs.mkdirSync(FOLDER_B, { recursive: true }); // no endpoints/ or gateways.yaml inside yet, on purpose

    wsEndpointRegistry = new EndpointRegistry(path.join(FOLDER_A, "endpoints"));
    wsGatewaysRegistry = new GatewaysRegistry(path.join(FOLDER_A, "gateways.yaml"));
    wsAuthProvidersRegistry = new AuthProvidersRegistry(path.join(FOLDER_A, "authProviders.yaml"));
    wsEndpointRegistry.reloadFromDisk();

    wsApp = createApp({
      endpointRegistry: wsEndpointRegistry,
      gatewaysRegistry: wsGatewaysRegistry,
      authProvidersRegistry: wsAuthProvidersRegistry,
      logger,
      workspace: wsWorkspace,
      settingsFile: WS_SETTINGS_FILE,
    });
  });

  afterAll(() => {
    fs.rmSync(WS_ROOT, { recursive: true, force: true });
  });

  it("reports the current workspace and counts", async () => {
    const res = await request(wsApp).get("/admin/api/settings").set(authed());
    expect(res.status).toBe(200);
    expect(res.body.configDir).toBe(FOLDER_A);
    expect(res.body.endpointCount).toBe(ENDPOINT_COUNT);
    expect(res.body.gatewayCount).toBeGreaterThan(0);
  });

  it("rejects switching to a folder that doesn't exist on disk", async () => {
    const res = await request(wsApp).put("/admin/api/settings").set(authed()).send({ configDir: MISSING_FOLDER });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/doesn't exist/i);
    // Nothing should have moved as a result of the rejected switch.
    expect(wsEndpointRegistry.getDir()).toBe(path.join(FOLDER_A, "endpoints"));
  });

  it("switches to a different (empty) folder, loading zero endpoints/gateways without error", async () => {
    const res = await request(wsApp).put("/admin/api/settings").set(authed()).send({ configDir: FOLDER_B });
    expect(res.status).toBe(200);
    expect(res.body.configDir).toBe(FOLDER_B);
    expect(res.body.endpointCount).toBe(0);
    expect(res.body.gatewayCount).toBe(0);
    expect(res.body.endpointErrors).toEqual([]);

    // The live dispatcher reflects the new (empty) folder immediately -- no
    // restart required, same as every other config change in this app.
    const endpointsRes = await request(wsApp).get("/__endpoints");
    expect(endpointsRes.body).toEqual([]);

    // The choice was persisted to disk, not just held in memory, so it
    // survives a restart.
    const persisted = JSON.parse(fs.readFileSync(WS_SETTINGS_FILE, "utf8"));
    expect(persisted.configDir).toBe(FOLDER_B);
  });

  it("switches back to folder A and the original endpoints reappear", async () => {
    const res = await request(wsApp).put("/admin/api/settings").set(authed()).send({ configDir: FOLDER_A });
    expect(res.status).toBe(200);
    expect(res.body.endpointCount).toBe(ENDPOINT_COUNT);

    const endpointsRes = await request(wsApp).get("/__endpoints");
    expect(endpointsRes.body).toHaveLength(ENDPOINT_COUNT);
  });

  it("an endpoint saved while pointed at folder B is written under folder B, not folder A", async () => {
    await request(wsApp).put("/admin/api/settings").set(authed()).send({ configDir: FOLDER_B });

    const created = await request(wsApp)
      .post("/admin/api/endpoints")
      .set(authed())
      .send({
        id: "folder-b-only-endpoint",
        method: "GET",
        path: "/api/folder-b/ping",
        backend: { type: "json", gateway: "someGw", url: "/customers", method: "GET" },
        output: { fields: [{ target: "customers", source: "$" }] },
      });
    // An endpoint only references a gateway by name at creation time (its
    // existence is checked when the endpoint is actually called, not when
    // it's saved) -- the point of this assertion is where the file lands,
    // not whether the referenced gateway is real.
    expect(created.status).toBe(201);
    expect(fs.existsSync(path.join(FOLDER_B, "endpoints", "api", "folder-b", "ping", "folder-b-only-endpoint.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(FOLDER_A, "endpoints", "api", "folder-b"))).toBe(false);
  });
});
