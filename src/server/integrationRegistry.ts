import fs from "node:fs";
import yaml from "js-yaml";
import { integrationConfigSchema, type IntegrationConfigParsed } from "../config/schema";
import { loadIntegrationConfigs } from "../config/loader";
import { ValidationError } from "./errors";
import { computeIntegrationFile } from "./integrationFileLayout";
import { missingFunctionNames } from "../transform/functionRefs";
import type { FunctionRegistry } from "../transform/functionRegistry";

interface Entry {
  config: IntegrationConfigParsed;
  file: string;
}

/**
 * Renamed from EndpointRegistry -- see WORKSPACE_APPS_DESIGN_NOTES.md.
 * Holds the currently-active set of Integrations (today's Endpoints, minus
 * `method`/`path`) in memory: load/save/list/get, mutable at runtime via
 * the console API exactly like EndpointRegistry was. Unlike
 * EndpointRegistry, this registry never matches an incoming HTTP request
 * directly -- an Integration isn't called by a client on its own, only
 * through a Route that references it by name (see MountedRouteRegistry,
 * which is what dispatch.ts actually matches requests against).
 */
export class IntegrationRegistry {
  private byId = new Map<string, Entry>();

  /** See EndpointRegistry's matching constructor comment -- unchanged. */
  constructor(private integrationsDir: string, private functionRegistry?: FunctionRegistry) {}

  getDir(): string {
    return this.integrationsDir;
  }

  setDir(integrationsDir: string): { errors: { file: string; error: string }[] } {
    this.integrationsDir = integrationsDir;
    return this.reloadFromDisk();
  }

  /** Re-reads every file in integrationsDir, replacing the current in-memory set. */
  reloadFromDisk(): { errors: { file: string; error: string }[] } {
    const { entries, errors } = loadIntegrationConfigs(this.integrationsDir);
    const next = new Map<string, Entry>();
    const allErrors = [...errors];

    for (const { config, file } of entries) {
      if (next.has(config.id)) {
        allErrors.push({ file, error: `Duplicate integration id "${config.id}"` });
        continue;
      }
      const missing = missingFunctionNames(config.output, this.functionRegistry);
      if (missing.length > 0) {
        allErrors.push({
          file,
          error: `References unknown transform function(s): ${missing.join(", ")}`,
        });
        continue;
      }
      next.set(config.id, { config, file });
    }

    this.byId = next;
    return { errors: allErrors };
  }

  list(): IntegrationConfigParsed[] {
    return [...this.byId.values()].map((e) => e.config);
  }

  get(id: string): IntegrationConfigParsed | undefined {
    return this.byId.get(id)?.config;
  }

  getFile(id: string): string | undefined {
    return this.byId.get(id)?.file;
  }

  /**
   * Validates an integration's id against every other currently-registered
   * integration (excluding `excludeId`), persists it to a flat
   * `<id>.yaml` file (see integrationFileLayout.ts -- no path-mirroring
   * folders, unlike EndpointRegistry's upsert), and registers it for
   * immediate use. Unlike EndpointRegistry.upsert(), there's no
   * method+path collision to check here -- that check now lives on
   * AppRegistry, against Routes, not Integrations.
   */
  upsert(input: unknown, opts: { excludeId?: string } = {}): { config: IntegrationConfigParsed; file: string } {
    const config = integrationConfigSchema.parse(input);

    const missing = missingFunctionNames(config.output, this.functionRegistry);
    if (missing.length > 0) {
      throw new ValidationError(`References unknown transform function(s): ${missing.join(", ")}`);
    }

    for (const [id] of this.byId) {
      if (id === opts.excludeId) continue;
      if (id === config.id) {
        throw new ValidationError(`Integration id "${config.id}" is already in use`);
      }
    }

    const file = computeIntegrationFile(this.integrationsDir, config);

    const oldId = opts.excludeId ?? config.id;
    const oldEntry = this.byId.get(oldId);
    if (oldId !== config.id) {
      this.byId.delete(oldId);
    }
    if (oldEntry && oldEntry.file !== file && fs.existsSync(oldEntry.file)) {
      fs.unlinkSync(oldEntry.file);
    }

    fs.mkdirSync(this.integrationsDir, { recursive: true });
    fs.writeFileSync(file, yaml.dump(config, { lineWidth: 100, noRefs: true }), "utf8");

    this.byId.set(config.id, { config, file });
    return { config, file };
  }

  /** Removes an integration from memory and deletes its backing file.
   * Does NOT check whether any Route still references it by name -- that
   * check belongs to whoever is about to remove something another config
   * depends on (see AppRegistry / consoleApi.ts), the same "the registry
   * being written to doesn't know about every other registry" boundary
   * EndpointRegistry already kept with gateway/function names. */
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
