import path from "node:path";
import { ValidationError } from "./errors";
import type { IntegrationConfigParsed, AppConfigParsed } from "../config/schema";

/**
 * Renamed from endpointFileLayout.ts -- see WORKSPACE_APPS_DESIGN_NOTES.md.
 * Today's Endpoint mirrored its URL `path` into nested folders (e.g.
 * "/api/customers/:id" -> api/customers/[id]/<id>.yaml), which made sense
 * when an endpoint's path WAS part of its identity. An Integration has no
 * `path` of its own anymore -- only a Route does -- so there's nothing left
 * to mirror into folders: both Integrations and Apps are stored flat, one
 * file named after the entity's own `id`.
 */
export function sanitizeConfigId(id: string, kind: "integration" | "app" = "integration"): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "");
  if (!cleaned) throw new ValidationError(`${kind === "app" ? "App" : "Integration"} id must contain at least one letter, digit, _ or -`);
  return cleaned;
}

/** Where one Integration's config file lives: a flat `<id>.yaml` directly
 * under `integrationsDir` -- no path-mirroring folders, since an
 * Integration no longer has a `path` of its own. */
export function computeIntegrationFile(integrationsDir: string, config: IntegrationConfigParsed): string {
  return path.join(integrationsDir, `${sanitizeConfigId(config.id, "integration")}.yaml`);
}

/** Where one App's config file lives: a flat `<id>.yaml` directly under
 * `appsDir`, holding that App's full list of Routes (see
 * WORKSPACE_APPS_DESIGN_NOTES.md's "Storage: same repo for v1"). */
export function computeAppFile(appsDir: string, config: AppConfigParsed): string {
  return path.join(appsDir, `${sanitizeConfigId(config.id, "app")}.yaml`);
}
