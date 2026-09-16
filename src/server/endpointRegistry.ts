import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { match, type MatchFunction } from "path-to-regexp";
import { endpointConfigSchema, type EndpointConfigParsed } from "../config/schema";
import { loadEndpointConfigs } from "../config/loader";
import { ValidationError } from "./errors";
import { computeEndpointFile } from "./endpointFileLayout";

interface Entry {
  config: EndpointConfigParsed;
  file: string;
  matcher: MatchFunction<Record<string, string>>;
}

export interface EndpointMatch {
  endpoint: EndpointConfigParsed;
  params: Record<string, string>;
}

/**
 * Holds the currently-active set of endpoints in memory and matches
 * incoming requests against them. Unlike registering one Express handler
 * per endpoint at startup, this can be mutated at runtime (by the admin
 * API or by reloading config/endpoints/ from disk) and takes effect on
 * the very next request -- no server restart required.
 */
export class EndpointRegistry {
  private byId = new Map<string, Entry>();

  constructor(private endpointsDir: string) {}

  /** The directory this registry is currently reading from/writing to. */
  getDir(): string {
    return this.endpointsDir;
  }

  /**
   * Repoints this registry at a different endpoints folder and reloads
   * from it immediately -- used by the admin UI's "Change folder" feature
   * (see workspaceSettings.ts) so switching to a different Git checkout
   * takes effect on the very next request, same as any other config
   * change.
   */
  setDir(endpointsDir: string): { errors: { file: string; error: string }[] } {
    this.endpointsDir = endpointsDir;
    return this.reloadFromDisk();
  }

  /** Re-reads every file in endpointsDir, replacing the current in-memory set. */
  reloadFromDisk(): { errors: { file: string; error: string }[] } {
    const { entries, errors } = loadEndpointConfigs(this.endpointsDir);
    const next = new Map<string, Entry>();
    const allErrors = [...errors];

    for (const { config, file } of entries) {
      if (next.has(config.id)) {
        allErrors.push({ file, error: `Duplicate endpoint id "${config.id}"` });
        continue;
      }
      next.set(config.id, { config, file, matcher: match(config.path) });
    }

    this.byId = next;
    return { errors: allErrors };
  }

  list(): EndpointConfigParsed[] {
    return [...this.byId.values()].map((e) => e.config);
  }

  get(id: string): EndpointConfigParsed | undefined {
    return this.byId.get(id)?.config;
  }

  getFile(id: string): string | undefined {
    return this.byId.get(id)?.file;
  }

  /**
   * Validates an endpoint against every other currently-registered
   * endpoint (excluding `excludeId`, so editing an endpoint doesn't
   * collide with itself), persists it to a file under endpointsDir whose
   * folder structure mirrors the endpoint's own path (see
   * endpointFileLayout.ts), and registers it for immediate matching.
   * Renaming an endpoint's id OR changing its path moves the file --
   * either one can change where it belongs on disk.
   */
  upsert(input: unknown, opts: { excludeId?: string } = {}): { config: EndpointConfigParsed; file: string } {
    const config = endpointConfigSchema.parse(input);

    for (const [id, entry] of this.byId) {
      if (id === opts.excludeId) continue;
      if (id === config.id) {
        throw new ValidationError(`Endpoint id "${config.id}" is already in use`);
      }
      if (entry.config.method === config.method && entry.config.path === config.path) {
        throw new ValidationError(
          `Endpoint ${config.method} ${config.path} is already used by endpoint "${id}"`
        );
      }
    }

    const file = computeEndpointFile(this.endpointsDir, config);

    // The entry being replaced is whichever id this upsert is standing in
    // for -- normally the same id, but `excludeId` on a rename means the
    // OLD id. Either way, if the new file location differs from where
    // that entry used to live (a path change moves it into a different
    // folder even with the same id; an id change moves the leaf filename
    // even with the same path), the stale file needs to go.
    const oldId = opts.excludeId ?? config.id;
    const oldEntry = this.byId.get(oldId);
    if (oldId !== config.id) {
      this.byId.delete(oldId);
    }
    if (oldEntry && oldEntry.file !== file && fs.existsSync(oldEntry.file)) {
      fs.unlinkSync(oldEntry.file);
      cleanupEmptyDirs(this.endpointsDir, path.dirname(oldEntry.file));
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.dump(config, { lineWidth: 100, noRefs: true }), "utf8");

    this.byId.set(config.id, { config, file, matcher: match(config.path) });
    return { config, file };
  }

  /** Removes an endpoint from memory, deletes its backing file, and prunes
   * any folders that are now empty as a result. */
  remove(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    if (fs.existsSync(entry.file)) {
      fs.unlinkSync(entry.file);
      cleanupEmptyDirs(this.endpointsDir, path.dirname(entry.file));
    }
    this.byId.delete(id);
    return true;
  }

  /** Finds the endpoint (if any) whose method+path matches this request. */
  match(method: string, pathname: string): EndpointMatch | undefined {
    for (const entry of this.byId.values()) {
      if (entry.config.method !== method) continue;
      const result = entry.matcher(pathname);
      if (result) {
        return { endpoint: entry.config, params: result.params as Record<string, string> };
      }
    }
    return undefined;
  }
}

/**
 * Walks up from `dir` toward (but not including) `endpointsDir`, removing
 * each directory that's now empty -- so an endpoint rename/delete that
 * leaves a folder with nothing left in it doesn't leave an empty folder
 * behind on disk. Stops at the first non-empty directory, or at
 * endpointsDir itself (which is never removed even if the whole tree is
 * empty).
 */
function cleanupEmptyDirs(endpointsDir: string, dir: string): void {
  const normalizedRoot = path.resolve(endpointsDir);
  let current = path.resolve(dir);

  while (current !== normalizedRoot && current.startsWith(normalizedRoot + path.sep)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}
