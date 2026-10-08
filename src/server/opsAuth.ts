import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Gates every /ops/api/* request behind a shared bearer token set via the
 * OPS_TOKEN environment variable. Structurally mirrors consoleAuth.ts's
 * requireConsoleAuth -- same fail-closed-if-unset behavior, same
 * timingSafeEqual comparison -- but deliberately its own token, not a
 * reuse of CONSOLE_TOKEN: the Ops Console is a different audience (an
 * operator watching a running QA/Production instance) with different,
 * arguably higher-stakes exposure (environment variables today; live
 * request/response capture in a later phase) than the Developer Console's
 * endpoint/gateway authoring ever had. See OPS_CONSOLE_DESIGN_NOTES.md.
 */
export function requireOpsAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.OPS_TOKEN;
  if (!token) {
    res.status(503).json({
      error: "OpsDisabled",
      message: "The Ops Console is disabled. Set OPS_TOKEN in your environment to enable it.",
    });
    return;
  }

  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const providedBuf = Buffer.from(provided);
  const tokenBuf = Buffer.from(token);
  const ok = providedBuf.length === tokenBuf.length && crypto.timingSafeEqual(providedBuf, tokenBuf);

  if (!ok) {
    res.status(401).json({ error: "Unauthorized", message: "Missing or invalid ops token." });
    return;
  }

  next();
}
