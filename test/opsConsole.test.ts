import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { EndpointRegistry } from "../src/server/endpointRegistry";
import { FunctionRegistry } from "../src/transform/functionRegistry";
import { GatewaysRegistry } from "../src/server/gatewaysRegistry";
import { AuthProvidersRegistry } from "../src/server/authProvidersRegistry";
import { createDataPlaneApp } from "../src/server/dataPlaneApp";
import { logger } from "../src/server/logger";
import { REDACTED } from "../src/server/secretRedaction";
import { stopSystemMonitor } from "../src/server/opsMetrics";

/**
 * Covers the Ops Console's Phase 1 surface (system monitoring + masked
 * env-var viewer) via createDataPlaneApp -- the same coreApp.ts building
 * blocks every target (dev/QA/Production) mounts it through, see
 * coreApp.ts's own comment. Deliberately run against the data-plane app,
 * not the full dev app: the whole point of OPS_TOKEN (vs. CONSOLE_TOKEN)
 * is that this surface is meant to exist in QA/Production too, so proving
 * it works there is the more meaningful check. dataPlane.test.ts already
 * covers the data-plane app's own routes; this file only adds /ops*
 * coverage on top.
 *
 * OPS_TOKEN is read fresh from process.env on every request by
 * requireOpsAuth (not captured once at mount time), so these tests flip
 * it between cases on the same running app instance rather than needing a
 * separate app per scenario.
 */

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-ops-console-test-"));
const ORIGINAL_OPS_TOKEN = process.env.OPS_TOKEN;

let app: Express;

beforeAll(() => {
  const functionRegistry = new FunctionRegistry(path.join(TMP_DIR, "transforms"));
  const endpointRegistry = new EndpointRegistry(path.join(TMP_DIR, "endpoints"), functionRegistry);
  const gatewaysRegistry = new GatewaysRegistry(path.join(TMP_DIR, "gateways.yaml"));
  const authProvidersRegistry = new AuthProvidersRegistry(path.join(TMP_DIR, "authProviders.yaml"));
  endpointRegistry.reloadFromDisk();

  app = createDataPlaneApp({ endpointRegistry, gatewaysRegistry, authProvidersRegistry, functionRegistry, logger });
});

afterEach(() => {
  if (ORIGINAL_OPS_TOKEN === undefined) delete process.env.OPS_TOKEN;
  else process.env.OPS_TOKEN = ORIGINAL_OPS_TOKEN;
});

afterAll(() => {
  stopSystemMonitor();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("Ops Console: auth gate (requireOpsAuth)", () => {
  it("503s with OpsDisabled when OPS_TOKEN is unset -- disabled by default, not merely unauthenticated", async () => {
    delete process.env.OPS_TOKEN;

    const system = await request(app).get("/ops/api/system");
    expect(system.status).toBe(503);
    expect(system.body.error).toBe("OpsDisabled");

    const env = await request(app).get("/ops/api/env");
    expect(env.status).toBe(503);
    expect(env.body.error).toBe("OpsDisabled");
  });

  it("401s with no token and with a wrong token once OPS_TOKEN is set", async () => {
    process.env.OPS_TOKEN = "correct-ops-token";

    const noAuth = await request(app).get("/ops/api/system");
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error).toBe("Unauthorized");

    const wrongToken = await request(app).get("/ops/api/system").set("Authorization", "Bearer wrong-token");
    expect(wrongToken.status).toBe(401);
    expect(wrongToken.body.error).toBe("Unauthorized");

    // A differently-shaped Authorization header (no "Bearer " prefix) must
    // also be rejected, not crash requireOpsAuth's slicing.
    const malformedHeader = await request(app).get("/ops/api/system").set("Authorization", "correct-ops-token");
    expect(malformedHeader.status).toBe(401);
  });

  it("200s once the correct bearer token is supplied", async () => {
    process.env.OPS_TOKEN = "correct-ops-token";

    const res = await request(app).get("/ops/api/system").set("Authorization", "Bearer correct-ops-token");
    expect(res.status).toBe(200);
  });
});

describe("Ops Console: GET /ops/api/system", () => {
  it("returns an instanceId plus a correctly-shaped latest sample and history", async () => {
    process.env.OPS_TOKEN = "correct-ops-token";

    const res = await request(app).get("/ops/api/system").set("Authorization", "Bearer correct-ops-token");
    expect(res.status).toBe(200);
    expect(typeof res.body.instanceId).toBe("string");
    expect(res.body.instanceId.length).toBeGreaterThan(0);

    const { latest } = res.body;
    expect(typeof latest.sampledAt).toBe("string");
    expect(typeof latest.uptimeSec).toBe("number");
    expect(Array.isArray(latest.loadavg)).toBe(true);
    expect(latest.loadavg).toHaveLength(3);
    expect(typeof latest.memory.rss).toBe("number");
    expect(typeof latest.memory.heapTotal).toBe("number");
    expect(typeof latest.cpu.percent).toBe("number");
    expect(typeof latest.cpu.coreCount).toBe("number");

    expect(Array.isArray(res.body.history)).toBe(true);
    expect(res.body.history.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Ops Console: GET /ops/api/env", () => {
  it("masks a sensitive-looking env var but leaves an ordinary one visible", async () => {
    process.env.OPS_TOKEN = "correct-ops-token";
    process.env.OPS_CONSOLE_TEST_API_KEY = "shhh-this-is-secret";
    process.env.OPS_CONSOLE_TEST_PLAIN_VALUE = "visible-value";

    try {
      const res = await request(app).get("/ops/api/env").set("Authorization", "Bearer correct-ops-token");
      expect(res.status).toBe(200);
      expect(res.body.env.OPS_CONSOLE_TEST_API_KEY).toBe(REDACTED);
      expect(res.body.env.OPS_CONSOLE_TEST_PLAIN_VALUE).toBe("visible-value");
      // OPS_TOKEN itself must also come through masked -- it matches
      // SENSITIVE_KEY_PATTERN ("token") same as any other secret-shaped key.
      expect(res.body.env.OPS_TOKEN).toBe(REDACTED);
    } finally {
      delete process.env.OPS_CONSOLE_TEST_API_KEY;
      delete process.env.OPS_CONSOLE_TEST_PLAIN_VALUE;
    }
  });
});
