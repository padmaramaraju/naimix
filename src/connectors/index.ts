import type { BackendConfig } from "../types/config";
import type { ConnectorContext, BackendResult } from "./types";
import type { ResolvedParams } from "./paramSubst";
import { callJsonBackend } from "./json";
import { callXmlBackend } from "./xml";
import { callSoapBackend } from "./soap";
import { callSqlBackend } from "./sql";

export async function callBackend(
  backend: BackendConfig,
  ctx: ConnectorContext
): Promise<BackendResult> {
  const effectiveCtx: ConnectorContext = { ...ctx, params: withGatewayCommonParams(backend, ctx) };

  switch (backend.type) {
    case "json":
      return callJsonBackend(backend, effectiveCtx);
    case "xml":
      return callXmlBackend(backend, effectiveCtx);
    case "soap":
      return callSoapBackend(backend, effectiveCtx);
    case "sql":
      return callSqlBackend(backend, effectiveCtx);
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unsupported backend type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Layers a gateway's `commonParams` (defaults shared by every endpoint
 * that uses it) underneath the request's own resolved params. Params the
 * endpoint itself supplied -- from the caller's request or an `in: "env"`
 * input -- take precedence over a same-named gateway default, since
 * they're more specific to this particular call.
 */
function withGatewayCommonParams(backend: BackendConfig, ctx: ConnectorContext): ResolvedParams {
  const gatewayName = "gateway" in backend ? backend.gateway : undefined;
  const gateway = gatewayName ? ctx.gateways.gateways[gatewayName] : undefined;
  const commonParams = gateway && "commonParams" in gateway ? gateway.commonParams : undefined;
  if (!commonParams) return ctx.params;
  return { ...commonParams, ...ctx.params };
}

export { closeAllSqlConnections } from "./sql";
export type { ConnectorContext, BackendResult } from "./types";
