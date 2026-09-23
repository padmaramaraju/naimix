import type { Request, Response, NextFunction } from "express";
import { callBackend, getBackendGatewayName } from "../connectors";
import { mapResponse } from "../transform/mapper";
import { extractParams } from "./paramExtractor";
import { AuthError, BackendError } from "./errors";
import type { AuthService } from "../auth/authService";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { Logger } from "./logger";

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return token || undefined;
}

/**
 * A single Express middleware that serves EVERY configured endpoint, by
 * looking up the current EndpointRegistry on each request rather than having
 * one static Express handler per endpoint. This is what makes endpoints
 * created, edited, or deleted through the admin API take effect immediately:
 * there's no per-endpoint handler to add/replace/remove in Express's own
 * router, just an in-memory table this middleware reads fresh every time.
 */
export function createDynamicDispatcher(
  endpointRegistry: EndpointRegistry,
  gatewaysRegistry: GatewaysRegistry,
  authService: AuthService,
  logger: Logger
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const matched = endpointRegistry.match(req.method, req.path);
    if (!matched) return next();

    const { endpoint, params: pathParams } = matched;
    Object.assign(req.params, pathParams);
    const endpointLogger = logger.child({ endpointId: endpoint.id });

    try {
      const params = extractParams(endpoint.input, req);
      const gateways = gatewaysRegistry.getResolved();

      // If the gateway this endpoint calls through declares `requiresAuth`,
      // the caller must present a session token this middleware itself
      // issued (via POST /auth/login/{provider}) for that exact provider.
      // On success, the real backend token that session holds is injected
      // as {__authToken} -- a reserved param name a gateway's own config
      // can reference (e.g. `headers: { Authorization: "Bearer
      // {__authToken}" }`) with zero connector-specific code, the same
      // {param} substitution engine every other param already uses. See
      // AUTH_DESIGN_NOTES.md.
      const gatewayName = getBackendGatewayName(endpoint.backend);
      const gateway = gatewayName ? gateways.gateways[gatewayName] : undefined;
      const requiresAuth = gateway && "requiresAuth" in gateway ? gateway.requiresAuth : undefined;
      if (requiresAuth) {
        const token = bearerToken(req);
        if (!token) {
          throw new AuthError(
            `This endpoint requires authentication. Log in via POST /auth/login/${requiresAuth} and send the returned token as "Authorization: Bearer <token>".`
          );
        }
        const session = await authService.resolveSession(token, requiresAuth);
        params.__authToken = session.backendToken;
      }

      endpointLogger.debug({ params }, "resolved input params");

      const backendResult = await callBackend(endpoint.backend, {
        gateways,
        params,
        logger: endpointLogger,
        rawQuery: req.query as Record<string, unknown>,
        rawBody: req.body,
      });

      const output = mapResponse(backendResult, endpoint.output);
      res.json(output);
    } catch (err) {
      next(wrapError(err));
    }
  };
}

function wrapError(err: unknown): Error {
  if (err instanceof Error && "statusCode" in err) return err;
  if (err instanceof Error) return new BackendError(err.message, 502);
  return new BackendError(String(err), 502);
}
