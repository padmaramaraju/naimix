import fs from "node:fs";
import yaml from "js-yaml";
import { appConfigSchema, type AppConfigParsed, type RouteConfigParsed } from "../config/schema";
import { loadAppConfigs } from "../config/loader";
import { ValidationError } from "./errors";
import { computeAppFile } from "./integrationFileLayout";
import type { IntegrationRegistry } from "./integrationRegistry";

interface Entry {
  config: AppConfigParsed;
  file: string;
}

/**
 * New -- see WORKSPACE_APPS_DESIGN_NOTES.md. Holds the currently-active set
 * of Apps in memory: load/save/list/get, mutable at runtime via the
 * console API, same shape as IntegrationRegistry/the old EndpointRegistry.
 * Each App is stored as one whole file (apps/<id>.yaml, including its full
 * list of Routes) -- there's no finer-grained "just this one route"
 * persistence primitive; the console API reads the whole App, edits one
 * route in memory, and calls upsert() with the whole updated App, the same
 * way editing one field of a gateway means re-saving that gateway's whole
 * entry.
 *
 * appConfigSchema's own superRefine (see schema.ts) already catches a
 * duplicate route id or a colliding method+path WITHIN the App being
 * saved. What that schema-level check CAN'T do -- because schema.ts has no
 * knowledge of what Integrations exist -- is confirm every route's
 * `integration` name actually resolves to something real. That's this
 * registry's job, via the injected IntegrationRegistry, following the
 * exact same "a bad reference is a load error, not a silent no-op"
 * convention as a bad gateway name or transform function name.
 */
export class AppRegistry {
  private byId = new Map<string, Entry>();

  /** Optional, matching FunctionRegistry's convention on IntegrationRegistry:
   * when omitted, any route's `integration` reference always fails
   * validation (there's nothing to resolve it against). Every real server
   * boot (dev, QA, Production) always provides one. */
  constructor(private appsDir: string, private integrationRegistry?: IntegrationRegistry) {}

  getDir(): string {
    return this.appsDir;
  }

  setDir(appsDir: string): { errors: { file: string; error: string }[] } {
    this.appsDir = appsDir;
    return this.reloadFromDisk();
  }

  private missingIntegrationNames(routes: RouteConfigParsed[]): string[] {
    const missing = new Set<string>();
    for (const route of routes) {
      if (!this.integrationRegistry || !this.integrationRegistry.get(route.integration)) {
        missing.add(route.integration);
      }
    }
    return [...missing];
  }

  /** Re-reads every file in appsDir, replacing the current in-memory set. */
  reloadFromDisk(): { errors: { file: string; error: string }[] } {
    const { entries, errors } = loadAppConfigs(this.appsDir);
    const next = new Map<string, Entry>();
    const allErrors = [...errors];

    for (const { config, file } of entries) {
      if (next.has(config.id)) {
        allErrors.push({ file, error: `Duplicate app id "${config.id}"` });
        continue;
      }
      const missing = this.missingIntegrationNames(config.routes);
      if (missing.length > 0) {
        allErrors.push({
          file,
          error: `References unknown integration(s): ${missing.join(", ")}`,
        });
        continue;
      }
      next.set(config.id, { config, file });
    }

    this.byId = next;
    return { errors: allErrors };
  }

  list(): AppConfigParsed[] {
    return [...this.byId.values()].map((e) => e.config);
  }

  get(id: string): AppConfigParsed | undefined {
    return this.byId.get(id)?.config;
  }

  getFile(id: string): string | undefined {
    return this.byId.get(id)?.file;
  }

  /**
   * Validates an App's id against every other currently-registered App
   * (excluding `excludeId`), validates every route's `integration`
   * reference, persists it to a flat `<id>.yaml` file, and registers it
   * for immediate use. The method+path / route-id collision checks
   * WITHIN this App already happened inside appConfigSchema.parse() below
   * -- a thrown ZodError from that surfaces as a 400 the same way any
   * other schema violation does.
   */
  upsert(input: unknown, opts: { excludeId?: string } = {}): { config: AppConfigParsed; file: string } {
    const config = appConfigSchema.parse(input);

    for (const [id] of this.byId) {
      if (id === opts.excludeId) continue;
      if (id === config.id) {
        throw new ValidationError(`App id "${config.id}" is already in use`);
      }
    }

    const missing = this.missingIntegrationNames(config.routes);
    if (missing.length > 0) {
      throw new ValidationError(`References unknown integration(s): ${missing.join(", ")}`);
    }

    const file = computeAppFile(this.appsDir, config);

    const oldId = opts.excludeId ?? config.id;
    const oldEntry = this.byId.get(oldId);
    if (oldId !== config.id) {
      this.byId.delete(oldId);
    }
    if (oldEntry && oldEntry.file !== file && fs.existsSync(oldEntry.file)) {
      fs.unlinkSync(oldEntry.file);
    }

    fs.mkdirSync(this.appsDir, { recursive: true });
    fs.writeFileSync(file, yaml.dump(config, { lineWidth: 100, noRefs: true }), "utf8");

    this.byId.set(config.id, { config, file });
    return { config, file };
  }

  /** Removes an App from memory and deletes its backing file. Does NOT
   * check whether any deployment.yaml `mounts` entry still references it
   * -- that's a boot-time check (see mountedRouteRegistry.ts), the same
   * "checked where it's used, not where it's defined" boundary every
   * other named reference in this project already follows. */
  remove(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    if (fs.existsSync(entry.file)) {
      fs.unlinkSync(entry.file);
    }
    this.byId.delete(id);
    return true;
  }
}
