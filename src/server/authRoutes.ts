import { Router, type Request, type Response, type NextFunction } from "express";
import type { AuthService } from "../auth/authService";
import type { Logger } from "./logger";

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return token || undefined;
}

/**
 * Caller-facing auth routes -- deliberately separate from both /admin/api/*
 * (a different audience: whoever configures this instance, gated by
 * ADMIN_TOKEN) and the business endpoints served by the dynamic dispatcher.
 * See AUTH_DESIGN_NOTES.md.
 */
export function createAuthRouter(authService: AuthService, logger: Logger): Router {
  const router = Router();
  const authLogger = logger.child({ component: "auth" });

  router.post(
    "/login/:provider",
    asyncHandler(async (req, res) => {
      const credentials = (req.body ?? {}) as Record<string, unknown>;
      const { token, expiresAt } = await authService.login(req.params.provider, credentials);
      authLogger.info({ provider: req.params.provider }, "login succeeded");
      res.json({ token, expiresAt });
    })
  );

  router.post(
    "/logout",
    asyncHandler(async (req, res) => {
      const token = bearerToken(req);
      if (token) {
        await authService.logout(token);
      }
      // Always 204: logging out an already-gone/never-valid token isn't an
      // error the caller needs to handle differently -- either way, that
      // token now doesn't work.
      res.status(204).end();
    })
  );

  return router;
}
