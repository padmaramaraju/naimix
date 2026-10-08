import os from "node:os";
import { Router } from "express";
import { redact } from "./secretRedaction";
import { getLatestSystemSample, getSystemHistory, startSystemMonitor } from "./opsMetrics";

/**
 * The Ops Console's API -- see OPS_CONSOLE_DESIGN_NOTES.md. Deliberately
 * structured as a small registry of named panels (one block per feature)
 * rather than one flat list of routes, so a later phase's panel (metrics,
 * logs, captures, settings) is an addition here, not a restructuring of
 * what's already there. Phase 1 covers only the two lowest-risk panels:
 * system monitoring and a masked, view-only env-var viewer. Mounted
 * behind requireOpsAuth by createBaseApp() -- see coreApp.ts.
 */
export function createOpsApiRouter(): Router {
  const router = Router();
  // Every response is tagged with an instance identifier -- not meaningful
  // for a single instance today, but what makes a later "scrape every
  // instance and merge" fleet view additive rather than a rework, per
  // OPS_CONSOLE_DESIGN_NOTES.md's "designed for future aggregation".
  const instanceId = process.env.INSTANCE_ID || `${os.hostname()}:${process.pid}`;

  startSystemMonitor();

  // ---- Panel: system (CPU/memory) ----
  router.get("/system", (_req, res) => {
    res.json({
      instanceId,
      latest: getLatestSystemSample(),
      history: getSystemHistory(),
    });
  });

  // ---- Panel: environment variables (view-only, masked) ----
  // Deliberately not editable -- see OPS_CONSOLE_DESIGN_NOTES.md's
  // "Feature: environment variables" for why "manage" was scoped down to
  // "view": most of this app's config is read once at startup, so a live
  // edit here wouldn't take effect without a restart anyway, and
  // DEPLOYMENT_ARCHITECTURE_NOTES.md already settled infrastructure
  // config as deployment-owned, not UI-edited. Reuses secretRedaction.ts's
  // own redact() -- the exact same SENSITIVE_KEY_PATTERN convention
  // gateway/auth-provider secrets already use -- rather than a second
  // redaction rule just for this panel.
  router.get("/env", (_req, res) => {
    res.json({
      instanceId,
      env: redact({ ...process.env }),
    });
  });

  return router;
}
