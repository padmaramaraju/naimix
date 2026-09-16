import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Gates every /admin/api/* request behind a shared bearer token set via the
 * ADMIN_TOKEN environment variable. The admin UI/API can configure endpoints
 * that call arbitrary backend URLs and SQL queries, so this is deliberately
 * required rather than optional: if ADMIN_TOKEN isn't set, the admin API is
 * disabled outright instead of silently running unauthenticated.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    res.status(503).json({
      error: "AdminDisabled",
      message: "The admin API is disabled. Set ADMIN_TOKEN in your environment to enable it.",
    });
    return;
  }

  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const providedBuf = Buffer.from(provided);
  const tokenBuf = Buffer.from(token);
  const ok = providedBuf.length === tokenBuf.length && crypto.timingSafeEqual(providedBuf, tokenBuf);

  if (!ok) {
    res.status(401).json({ error: "Unauthorized", message: "Missing or invalid admin token." });
    return;
  }

  next();
}
