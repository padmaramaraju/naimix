import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import type { XmlBackendConfig } from "../types/config";
import { substituteParams } from "./paramSubst";
import type { ConnectorContext, BackendResult } from "./types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  // Keep every text value exactly as written in the XML -- fast-xml-parser's
  // default auto-guesses numbers/booleans from tag text (e.g. "007" -> 7,
  // "true" -> true), which silently corrupts anything that merely looks
  // numeric/boolean but isn't (a zero-padded id, a status code). Anyone who
  // actually wants a real number/boolean opts in explicitly per output field
  // via `transform: toNumber`/`toBoolean` (see transform/mapper.ts) instead
  // of the parser guessing for them.
  parseTagValue: false,
  parseAttributeValue: false,
});

export async function callXmlBackend(
  backend: XmlBackendConfig,
  ctx: ConnectorContext
): Promise<BackendResult> {
  const gw = backend.gateway ? ctx.gateways.gateways[backend.gateway] : undefined;
  if (backend.gateway && !gw) {
    throw new Error(`Unknown gateway "${backend.gateway}" referenced by XML backend`);
  }
  const baseUrl = gw && "baseUrl" in gw ? gw.baseUrl ?? "" : "";
  const gwHeaders = gw && "headers" in gw ? gw.headers ?? {} : {};

  const rawUrl = baseUrl && !/^https?:\/\//i.test(backend.url) ? baseUrl + backend.url : backend.url;
  const url = substituteParams(rawUrl, ctx.params);
  const headers = substituteParams(
    { "Content-Type": "application/xml", ...gwHeaders, ...(backend.headers ?? {}) },
    ctx.params
  );
  const body = backend.body ? substituteParams(backend.body, ctx.params) : undefined;

  ctx.logger.debug({ url, method: backend.method }, "calling XML backend");

  const response = await axios.request({
    url,
    method: backend.method ?? "GET",
    headers,
    data: body,
    timeout: backend.timeoutMs ?? 10000,
    responseType: "text",
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(
      `XML backend returned HTTP ${response.status} for ${backend.method ?? "GET"} ${url}`
    ) as Error & { statusCode?: number; backendBody?: unknown };
    err.statusCode = response.status;
    err.backendBody = response.data;
    throw err;
  }

  // Preserve the exact wire response for debugging (e.g. LOG_LEVEL=debug) --
  // the object below is a lossy reshaping of it (see TECHNICAL.md's "Output
  // mapping" section), so keeping the original text around is the only way
  // to see what actually came back when a mapping produces something
  // unexpected.
  ctx.logger.debug({ url, rawResponse: response.data }, "XML backend raw response");

  return parser.parse(response.data as string);
}
