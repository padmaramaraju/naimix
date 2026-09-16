import type { GatewaysFileParsed } from "../config/schema";
import type { ResolvedParams } from "./paramSubst";

export interface ConnectorContext {
  gateways: GatewaysFileParsed;
  params: ResolvedParams;
  logger: { debug: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  /** The caller's raw query string object, verbatim (Express's req.query). Only
   * consumed by the SQL connector's generated `list` operation, for filtering/
   * pagination -- every other backend type ignores it. */
  rawQuery?: Record<string, unknown>;
  /** The caller's raw parsed JSON body, verbatim (Express's req.body). Only
   * consumed by the SQL connector's generated bulkCreate/bulkUpdate/bulkDelete
   * operations, which need a whole array rather than named scalar params. */
  rawBody?: unknown;
}

/** All connectors return a plain JS value (object/array) ready for JSONPath mapping. */
export type BackendResult = unknown;
