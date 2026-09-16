import * as soap from "soap";
import type { SoapBackendConfig } from "../types/config";
import { substituteParams } from "./paramSubst";
import type { ConnectorContext, BackendResult } from "./types";

// SOAP clients are cheap-ish to build but WSDL fetch/parse is not; cache per WSDL URL.
const clientCache = new Map<string, Promise<soap.Client>>();

function getClient(wsdlUrl: string): Promise<soap.Client> {
  let cached = clientCache.get(wsdlUrl);
  if (!cached) {
    cached = soap.createClientAsync(wsdlUrl);
    clientCache.set(wsdlUrl, cached);
  }
  return cached;
}

export async function callSoapBackend(
  backend: SoapBackendConfig,
  ctx: ConnectorContext
): Promise<BackendResult> {
  const gw = backend.gateway ? ctx.gateways.gateways[backend.gateway] : undefined;
  if (backend.gateway && !gw) {
    throw new Error(`Unknown gateway "${backend.gateway}" referenced by SOAP backend`);
  }
  const wsdl = ("wsdl" in (gw ?? {}) && (gw as { wsdl?: string }).wsdl) || backend.wsdl;
  if (!wsdl) {
    throw new Error(
      `SOAP backend has no WSDL URL: set "wsdl" on the endpoint or "wsdl" on its gateway "${backend.gateway ?? ""}"`
    );
  }
  const resolvedWsdl = substituteParams(wsdl, ctx.params);
  const args = substituteParams(backend.args ?? {}, ctx.params);

  ctx.logger.debug({ wsdl: resolvedWsdl, operation: backend.operation }, "calling SOAP backend");

  const client = await getClient(resolvedWsdl);

  const endpoint = backend.endpoint
    ? substituteParams(backend.endpoint, ctx.params)
    : resolvedWsdl.split("?")[0];
  client.setEndpoint(endpoint);

  const method = (client as unknown as Record<string, unknown>)[`${backend.operation}Async`];
  if (typeof method !== "function") {
    throw new Error(
      `SOAP operation "${backend.operation}" was not found on the client described by ${resolvedWsdl}`
    );
  }

  if (backend.soapHeaders) {
    for (const header of backend.soapHeaders) {
      client.addSoapHeader(substituteParams(header, ctx.params));
    }
  }

  const [result] = (await method.call(client, args)) as [unknown];

  // Preserve the exact wire response for debugging (e.g. LOG_LEVEL=debug) --
  // `client.lastResponse` is the raw SOAP envelope XML the `soap` library
  // captured for this call, alongside `result` (the already-unwrapped body
  // it parsed). See TECHNICAL.md's "Output mapping" section.
  ctx.logger.debug(
    { wsdl: resolvedWsdl, operation: backend.operation, rawResponse: client.lastResponse },
    "SOAP backend raw response"
  );

  return result;
}
