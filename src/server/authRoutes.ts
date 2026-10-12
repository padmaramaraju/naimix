import { Router, type Request, type Response, type NextFunction } from "express";
import { AuthService } from "../auth/authService";
import { buildAuthorizationRequest, exchangeAuthorizationCode } from "../auth/oauthCodeFlow";
import type { OAuthPendingFlowStore } from "../auth/oauthPendingFlowStore";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";
import type { OAuth2ProviderConfig } from "../types/config";
import { AuthError } from "./errors";
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

/** Resolves a named auth provider's env-substituted config, narrowed to
 * "it's an oauth2 provider configured for the authorizationCode grant" --
 * the only shape both new routes below ever operate on. Returns undefined
 * for a missing provider, a provider of a different kind, or an oauth2
 * provider on a different grant, so every caller gets one place to decide
 * what a mismatch here means (currently: a 400, never a silent fallback to
 * some other behavior). */
function resolveOAuthCodeProvider(registry: AuthProvidersRegistry, name: string): OAuth2ProviderConfig | undefined {
  const config = registry.getResolved().authProviders[name];
  if (!config || config.kind !== "oauth2" || config.grantType !== "authorizationCode") {
    return undefined;
  }
  return config;
}

/** The raw query string exactly as the request arrived, parsed once -- used
 * for both forwarding it verbatim into the token exchange (see
 * exchangeAuthorizationCode's incomingSearch) and reading individual
 * fields, rather than relying on Express's own qs-based `req.query`, whose
 * parsing conventions (nested objects, arrays) don't match the flat
 * string-only params a redirect-based OAuth response actually uses. */
function rawQuery(req: Request): URLSearchParams {
  const queryString = req.originalUrl.split("?")[1] ?? "";
  return new URLSearchParams(queryString);
}

/**
 * Caller-facing auth routes -- deliberately separate from both /console/api/*
 * (a different audience: whoever configures this instance, gated by
 * CONSOLE_TOKEN) and the business endpoints served by the dynamic dispatcher.
 * See AUTH_DESIGN_NOTES.md.
 */
export function createAuthRouter(
  authService: AuthService,
  authProvidersRegistry: AuthProvidersRegistry,
  pendingFlowStore: OAuthPendingFlowStore,
  logger: Logger
): Router {
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

  // ---------------------------------------------------------------------
  // OAuth Authorization Code -- see AUTH_DESIGN_NOTES.md's "OAuth
  // Authorization Code" section and "Client Integration Guide" for the
  // full design this implements. Two routes, deliberately NOT gated by any
  // bearer token: the browser arriving here has no naimix credential yet
  // (that's the whole point of these two routes), and /callback in
  // particular must sit outside that gate since it's the real provider's
  // redirect target, not a call this app's own client code makes directly.
  // ---------------------------------------------------------------------

  router.get(
    "/oauth/:provider/start",
    asyncHandler(async (req, res) => {
      const providerName = req.params.provider;
      const config = resolveOAuthCodeProvider(authProvidersRegistry, providerName);
      if (!config) {
        return res.status(400).json({
          error: "InvalidProvider",
          message: `"${providerName}" is not an auth provider configured for the authorizationCode grant`,
        });
      }

      const appClientId = typeof req.query.app === "string" ? req.query.app : undefined;
      const returnTo = typeof req.query.return_to === "string" ? req.query.return_to : undefined;
      const appState = typeof req.query.state === "string" ? req.query.state : undefined;
      if (!appClientId || !returnTo) {
        return res.status(400).json({ error: "InvalidRequest", message: "`app` and `return_to` query params are both required" });
      }

      // Exact match only -- no partial/wildcard matching -- against this
      // provider's own registered clients. This is the allow-list that
      // closes the open-redirect risk: see OAuthClientAppConfig's doc
      // comment in src/types/config.ts.
      const client = (config.clients ?? []).find((c) => c.id === appClientId);
      if (!client || !client.returnTo.includes(returnTo)) {
        authLogger.warn({ provider: providerName, appClientId, returnTo }, "oauth start rejected: app/return_to not registered");
        return res
          .status(400)
          .json({ error: "UnregisteredClient", message: `"${appClientId}"/"${returnTo}" is not a registered app/return_to pair for "${providerName}"` });
      }

      const { redirectUrl, state, codeVerifier } = await buildAuthorizationRequest(config);
      await pendingFlowStore.set(state, {
        providerName,
        codeVerifier,
        appClientId,
        returnTo,
        appState,
        createdAt: Date.now(),
      });

      authLogger.info({ provider: providerName, appClientId }, "oauth start");
      res.redirect(302, redirectUrl);
    })
  );

  router.get(
    "/oauth/:provider/callback",
    asyncHandler(async (req, res) => {
      const providerName = req.params.provider;
      const query = rawQuery(req);
      const internalState = query.get("state");

      if (!internalState) {
        return res.status(400).json({ error: "InvalidRequest", message: "Missing state parameter" });
      }

      const flow = await pendingFlowStore.get(internalState);
      // Single-use regardless of outcome: a replayed callback request with
      // the same state can't complete (or re-complete) this exchange.
      await pendingFlowStore.delete(internalState);

      if (!flow || flow.providerName !== providerName) {
        return res.status(400).json({ error: "InvalidRequest", message: "Unknown, expired, or already-used login attempt" });
      }

      // Re-resolve (and re-validate the client/return_to pair) rather than
      // trusting the pending-flow record alone -- the provider's config
      // could have been edited via the console UI since /start ran (e.g.
      // this app removed from `clients`). If that allow-list check no
      // longer passes, this does NOT redirect to flow.returnTo: that URL
      // is exactly what just stopped being trusted, so the only safe
      // response is a direct error, not a redirect anywhere.
      const config = resolveOAuthCodeProvider(authProvidersRegistry, providerName);
      const client = config?.clients?.find((c) => c.id === flow.appClientId);
      if (!config || !client || !client.returnTo.includes(flow.returnTo)) {
        authLogger.error({ provider: providerName, appClientId: flow.appClientId }, "oauth callback: provider/client no longer valid");
        return res.status(400).json({ error: "InvalidProvider", message: "This login attempt is no longer valid" });
      }

      const destination = new URL(flow.returnTo);
      const fragment = new URLSearchParams();
      if (flow.appState) fragment.set("state", flow.appState);

      const providerError = query.get("error");
      if (providerError) {
        // The user denied consent, or the provider otherwise failed the
        // request on its end -- hand that off to the calling app via its
        // own return_to, per the "the callback hands off via return_to,
        // not a page of our own" decision, rather than showing naimix's
        // own error page for something the real provider reported.
        fragment.set("error", providerError);
        const description = query.get("error_description");
        if (description) fragment.set("error_description", description);
        destination.hash = fragment.toString();
        authLogger.info({ provider: providerName, error: providerError }, "oauth callback: provider reported an error");
        return res.redirect(302, destination.href);
      }

      try {
        const result = await exchangeAuthorizationCode(config, {
          incomingSearch: query,
          expectedState: internalState,
          codeVerifier: flow.codeVerifier,
        });
        const { token, expiresAt } = await authService.completeOAuthLogin(providerName, result);
        fragment.set("token", token);
        if (expiresAt) fragment.set("expires_at", String(expiresAt));
        destination.hash = fragment.toString();
        authLogger.info({ provider: providerName, appClientId: flow.appClientId }, "oauth login succeeded");
        res.redirect(302, destination.href);
      } catch (err) {
        const message = err instanceof AuthError ? err.message : "Login failed";
        authLogger.error({ provider: providerName, err: err instanceof Error ? err.message : err }, "oauth callback exchange failed");
        fragment.set("error", "login_failed");
        fragment.set("error_description", message);
        destination.hash = fragment.toString();
        res.redirect(302, destination.href);
      }
    })
  );

  return router;
}
