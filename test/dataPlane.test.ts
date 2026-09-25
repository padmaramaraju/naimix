import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { EndpointRegistry } from "../src/server/endpointRegistry";
import { GatewaysRegistry } from "../src/server/gatewaysRegistry";
import { AuthProvidersRegistry } from "../src/server/authProvidersRegistry";
import { createDataPlaneApp } from "../src/server/dataPlaneApp";
import { logger } from "../src/server/logger";

/**
 * Proves the QA/Production build's actual behavior, not just app.ts's --
 * see DEPLOYMENT_ARCHITECTURE_NOTES.md's "Installation: how development
 * differs from QA/Production" and dataPlaneApp.ts's own comment. This is
 * the functional (black-box, "what does the running server actually
 * answer") half of that proof; scripts/checkDataPlaneBundle.js is the
 * structural (module-graph/bundle-contents) half, run by
 * `npm run build:data-plane`.
 *
 * Deliberately minimal fixtures -- an empty (nonexistent-until-loaded)
 * workspace, not a copy of the real demo config -- because this file's job
 * is only to confirm what IS and ISN'T mounted, not to re-verify business
 * logic (endpoint dispatch, gateway calls, real auth-provider logins),
 * which middleware.test.ts already covers thoroughly through the exact
 * same coreApp.ts building blocks this app is made of.
 */

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-data-plane-test-"));

let app: Express;

beforeAll(() => {
  // Every one of these tolerates a missing file/directory, loading as
  // empty -- see workspaceSettings.ts's resolveConfigDir() doc comment.
  const endpointRegistry = new EndpointRegistry(path.join(TMP_DIR, "endpoints"));
  const gatewaysRegistry = new GatewaysRegistry(path.join(TMP_DIR, "gateways.yaml"));
  const authProvidersRegistry = new AuthProvidersRegistry(path.join(TMP_DIR, "authProviders.yaml"));
  endpointRegistry.reloadFromDisk();

  app = createDataPlaneApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, logger });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("data-plane app (QA/Production build): admin console is structurally absent, not just disabled", () => {
  it("still serves the caller-facing surface: /healthz, /__endpoints, /auth", async () => {
    const health = await request(app).get("/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok", endpointCount: 0 });

    const endpoints = await request(app).get("/__endpoints");
    expect(endpoints.status).toBe(200);
    expect(endpoints.body).toEqual([]);

    // /auth/login is mounted and doing real validation (a different code
    // path than "route doesn't exist") -- this is the caller-facing login
    // surface, a different audience from the admin console, and it must
    // still work here even though the admin console doesn't. See
    // AUTH_DESIGN_NOTES.md.
    const login = await request(app).post("/auth/login/doesNotExist").send({ username: "x", password: "y" });
    expect(login.status).toBe(400);
  });

  it("404s a bare GET /admin -- the admin UI's static files aren't mounted at all", async () => {
    const res = await request(app).get("/admin");
    expect(res.status).toBe(404);
    // The full/dev app (app.ts, with adminUiDir set) 301-redirects this to
    // /admin/ and then serves index.html -- confirming this isn't that.
    expect(res.body).toEqual({ error: "Not Found", path: "/admin" });
  });

  it("404s every /admin/api/* route -- no ADMIN_TOKEN check ever runs, because there's no admin router to gate", async () => {
    // Every one of these would be a 401/403/503 in the full app (missing/
    // wrong ADMIN_TOKEN) if the admin API existed here at all but merely
    // rejected the request. A plain 404 with the generic "Not Found" body
    // (not adminAuth.ts's "AdminDisabled"/"Unauthorized" JSON shape) is the
    // signature of the route never having been registered in the first
    // place -- see coreApp.ts/dataPlaneApp.ts.
    const routes: Array<[string, string]> = [
      ["get", "/admin/api/meta"],
      ["get", "/admin/api/endpoints"],
      ["get", "/admin/api/gateways"],
      ["get", "/admin/api/auth-providers"],
      ["get", "/admin/api/sessions"],
      ["delete", "/admin/api/sessions/whatever"],
      ["post", "/admin/api/auth-providers/test-login"],
      ["get", "/admin/api/settings"],
      ["get", "/admin/api/export/openapi.json"],
      ["get", "/admin/api/export/mcp-server"],
    ];

    for (const [method, url] of routes) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(404);
      expect(res.body, `${method.toUpperCase()} ${url}`).toEqual({ error: "Not Found", path: url });
    }
  });

  it("404s /admin/api/sessions even when an ADMIN_TOKEN happens to be set in the environment", async () => {
    // Guards against a future regression where someone "fixes" this by
    // gating the route with requireAdminAuth instead of never mounting it
    // -- that would make this test fail the moment ADMIN_TOKEN is set,
    // which is exactly the outcome this whole feature exists to prevent in
    // QA/Production.
    const previous = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "some-token-that-would-work-against-the-full-app";
    try {
      const res = await request(app).get("/admin/api/sessions").set("Authorization", "Bearer some-token-that-would-work-against-the-full-app");
      expect(res.status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = previous;
    }
  });
});
