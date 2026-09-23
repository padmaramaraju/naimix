import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  gatewaysFileSchema,
  endpointConfigSchema,
  authProvidersFileSchema,
  type EndpointConfigParsed,
  type GatewaysFileParsed,
  type AuthProvidersFileParsed,
} from "./schema";
import { substituteEnv } from "./envSubst";

export function readStructuredFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    return JSON.parse(raw);
  }
  return yaml.load(raw);
}

const CONFIG_EXTENSIONS = [".yaml", ".yml", ".json"];

/**
 * Recursively collects every config file under `dir`. Endpoints may be
 * organized into nested folders that mirror their URL path (see
 * src/server/endpointFileLayout.ts), so this can no longer be a flat
 * single-level readdir -- but it works just as well for the (flat)
 * gateways-file use case too, since a flat directory is just a tree of
 * depth 1.
 */
function listConfigFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && CONFIG_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  };
  walk(dir);

  return results.sort();
}

export interface EndpointConfigEntry {
  config: EndpointConfigParsed;
  /** Absolute path to the file this endpoint was loaded from. */
  file: string;
}

export interface LoadedEndpoints {
  entries: EndpointConfigEntry[];
  errors: { file: string; error: string }[];
}

/**
 * Loads and validates every endpoint config file in `endpointsDir`. A
 * malformed file (bad YAML, schema violation, duplicate id/path) is
 * reported in `errors` and skipped rather than throwing, so one bad file
 * never takes down every other endpoint.
 */
export function loadEndpointConfigs(endpointsDir: string): LoadedEndpoints {
  const entries: EndpointConfigEntry[] = [];
  const errors: { file: string; error: string }[] = [];
  const seenIds = new Map<string, string>();
  const seenPaths = new Map<string, string>();

  for (const file of listConfigFiles(endpointsDir)) {
    try {
      const raw = substituteEnv(readStructuredFile(file));
      const parsed = endpointConfigSchema.parse(raw);

      if (seenIds.has(parsed.id)) {
        throw new Error(
          `Duplicate endpoint id "${parsed.id}" (already defined in ${seenIds.get(parsed.id)})`
        );
      }
      const pathKey = `${parsed.method} ${parsed.path}`;
      if (seenPaths.has(pathKey)) {
        throw new Error(
          `Duplicate endpoint ${pathKey} (already defined in ${seenPaths.get(pathKey)})`
        );
      }
      seenIds.set(parsed.id, file);
      seenPaths.set(pathKey, file);
      entries.push({ config: parsed, file });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { entries, errors };
}

/** Loads gateways.yaml WITHOUT resolving ${env.X} placeholders -- used by
 * the admin UI so it can show/preserve "this field references an env var"
 * rather than the resolved secret. */
export function loadGatewaysRaw(gatewaysFile: string): GatewaysFileParsed {
  if (!fs.existsSync(gatewaysFile)) {
    return { gateways: {} };
  }
  const raw = readStructuredFile(gatewaysFile);
  return gatewaysFileSchema.parse(raw);
}

/** Loads gateways.yaml WITH ${env.X} placeholders resolved -- used at
 * request time to actually call backends. */
export function loadGateways(gatewaysFile: string): GatewaysFileParsed {
  if (!fs.existsSync(gatewaysFile)) {
    return { gateways: {} };
  }
  const raw = substituteEnv(readStructuredFile(gatewaysFile));
  return gatewaysFileSchema.parse(raw);
}

/** Loads authProviders.yaml WITHOUT resolving ${env.X} placeholders -- same
 * "show/preserve an env reference, don't resolve it" convention as
 * loadGatewaysRaw, for a future admin UI. */
export function loadAuthProvidersRaw(file: string): AuthProvidersFileParsed {
  if (!fs.existsSync(file)) {
    return { authProviders: {} };
  }
  const raw = readStructuredFile(file);
  return authProvidersFileSchema.parse(raw);
}

/** Loads authProviders.yaml WITH ${env.X} placeholders resolved -- used at
 * request time to actually log a caller in against a provider. */
export function loadAuthProviders(file: string): AuthProvidersFileParsed {
  if (!fs.existsSync(file)) {
    return { authProviders: {} };
  }
  const raw = substituteEnv(readStructuredFile(file));
  return authProvidersFileSchema.parse(raw);
}
