import axios from "axios";
import type { JsonBackendConfig } from "../types/config";
import { substituteParams } from "./paramSubst";
import type { ConnectorContext, BackendResult } from "./types";

export async function callJsonBackend(
  backend: JsonBackendConfig,
  ctx: ConnectorContext
): Promise<BackendResult> {
  const gw = backend.gateway ? ctx.gateways.gateways[backend.gateway] : undefined;
  if (backend.gateway && !gw) {
    throw new Error(`Unknown gateway "${backend.gateway}" referenced by JSON backend`);
  }
  const baseUrl = gw && "baseUrl" in gw ? gw.baseUrl ?? "" : "";
  const gwHeaders = gw && "headers" in gw ? gw.headers ?? {} : {};

  const rawUrl = baseUrl && !/^https?:\/\//i.test(backend.url) ? baseUrl + backend.url : backend.url;
  const url = substituteParams(rawUrl, ctx.params);
  const headers = substituteParams({ ...gwHeaders, ...(backend.headers ?? {}) }, ctx.params);
  const query = backend.query ? substituteParams(backend.query, ctx.params) : undefined;
  const body = backend.body ? substituteParams(backend.body, ctx.params) : undefined;

  ctx.logger.debug({ url, method: backend.method }, "calling JSON backend");

  const response = await axios.request({
    url,
    method: backend.method ?? "GET",
    headers,
    params: query,
    data: body,
    timeout: backend.timeoutMs ?? 10000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(
      `JSON backend returned HTTP ${response.status} for ${backend.method ?? "GET"} ${url}`
    ) as Error & { statusCode?: number; backendBody?: unknown };
    err.statusCode = response.status;
    err.backendBody = response.data;
    throw err;
  }

  return response.data;
}
