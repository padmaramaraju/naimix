import path from "node:path";
import { ValidationError } from "./errors";
import type { EndpointConfigParsed } from "../config/schema";

/**
 * Turns an endpoint's URL path into on-disk folder segments, so
 * config/endpoints/ mirrors the API surface instead of being one flat
 * directory of <id>.yaml files. E.g. "/api/customers/:id" becomes
 * ["api", "customers", "[id]"].
 *
 * This is purely a storage-layout convenience -- it has no bearing on how
 * requests are actually matched (EndpointRegistry.match() only ever looks
 * at the `path` field parsed out of the YAML, never the file's location),
 * so reorganizing files on disk can never change runtime behavior.
 *
 * A path param segment (":id", optionally with a path-to-regexp
 * constraint like ":id(\\d+)") becomes "[id]" -- square brackets are safe
 * on every OS (":" is not, on Windows), and the bracket convention reads
 * clearly as "this is a parameter" when browsing the folder tree.
 */
export function endpointPathToFolderSegments(endpointPath: string): string[] {
  return endpointPath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1).replace(/[^A-Za-z0-9_].*$/, "");
        return `[${sanitizeSegment(name || "param")}]`;
      }
      return sanitizeSegment(segment);
    });
}

function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-");
  return cleaned || "_";
}

export function sanitizeEndpointFilename(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "");
  if (!cleaned) throw new ValidationError("Endpoint id must contain at least one letter, digit, _ or -");
  return cleaned;
}

/**
 * Computes where an endpoint's config file belongs on disk: a folder per
 * path segment (so every endpoint sharing a path -- e.g. GET/POST/PATCH/
 * DELETE on the same generated-CRUD resource -- lands in the same
 * folder), with the endpoint's own id as the leaf filename (so multiple
 * methods on one path don't collide, and renaming an endpoint's id alone
 * doesn't require also touching its path).
 */
export function computeEndpointFile(endpointsDir: string, config: EndpointConfigParsed): string {
  const segments = endpointPathToFolderSegments(config.path);
  const filename = `${sanitizeEndpointFilename(config.id)}.yaml`;
  return path.join(endpointsDir, ...segments, filename);
}
