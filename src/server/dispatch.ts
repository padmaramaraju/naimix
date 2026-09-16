import type { Request, Response, NextFunction } from "express";
import { callBackend } from "../connectors";
import { mapResponse } from "../transform/mapper";
import { extractParams } from "./paramExtractor";
import { BackendError } from "./errors";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { Logger } from "./logger";

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
      endpointLogger.debug({ params }, "resolved input params");

      const backendResult = await callBackend(endpoint.backend, {
        gateways: gatewaysRegistry.getResolved(),
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
