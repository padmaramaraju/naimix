import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  gatewaysFileSchema,
  integrationConfigSchema,
  authProvidersFileSchema,
  appConfigSchema,
  deploymentConfigSchema,
  type IntegrationConfigParsed,
  type GatewaysFileParsed,
  type AuthProvidersFileParsed,
  type AppConfigParsed,
  type DeploymentConfigParsed,
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

export interface IntegrationConfigEntry {
  config: IntegrationConfigParsed;
  /** Absolute path to the file this integration was loaded from. */
  file: string;
}

export interface LoadedIntegrations {
  entries: IntegrationConfigEntry[];
  errors: { file: string; error: string }[];
}

/**
 * Loads and validates every Integration config file in `integrationsDir`
 * (flat -- see integrationFileLayout.ts; an Integration has no `path` of
 * its own to mirror into folders, unlike today's Endpoints). A malformed
 * file (bad YAML, schema violation, duplicate id) is reported in `errors`
 * and skipped rather than throwing, so one bad file never takes down every
 * other Integration.
 */
export function loadIntegrationConfigs(integrationsDir: string): LoadedIntegrations {
  const entries: IntegrationConfigEntry[] = [];
  const errors: { file: string; error: string }[] = [];
  const seenIds = new Map<string, string>();

  for (const file of listConfigFiles(integrationsDir)) {
    try {
      const raw = substituteEnv(readStructuredFile(file));
      const parsed = integrationConfigSchema.parse(raw);

      if (seenIds.has(parsed.id)) {
        throw new Error(
          `Duplicate integration id "${parsed.id}" (already defined in ${seenIds.get(parsed.id)})`
        );
      }
      seenIds.set(parsed.id, file);
      entries.push({ config: parsed, file });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { entries, errors };
}

export interface AppConfigEntry {
  config: AppConfigParsed;
  /** Absolute path to the file this App was loaded from (apps/<id>.yaml). */
  file: string;
}

export interface LoadedApps {
  entries: AppConfigEntry[];
  errors: { file: string; error: string }[];
}

/**
 * Loads and validates every App config file in `appsDir` (one App per
 * file -- see WORKSPACE_APPS_DESIGN_NOTES.md). appConfigSchema's own
 * superRefine already catches a duplicate route id or a colliding
 * method+path WITHIN one App's own file; this function additionally
 * catches a duplicate App id ACROSS files. It does NOT check that each
 * route's `integration` name actually exists -- that's a cross-file check
 * against the Integration registry, done by AppRegistry, the same
 * "resolved one layer up" pattern transform-function references already
 * follow (see functionRefs.ts / missingFunctionNames()).
 */
export function loadAppConfigs(appsDir: string): LoadedApps {
  const entries: AppConfigEntry[] = [];
  const errors: { file: string; error: string }[] = [];
  const seenIds = new Map<string, string>();

  for (const file of listConfigFiles(appsDir)) {
    try {
      const raw = readStructuredFile(file);
      const parsed = appConfigSchema.parse(raw);

      if (seenIds.has(parsed.id)) {
        throw new Error(`Duplicate app id "${parsed.id}" (already defined in ${seenIds.get(parsed.id)})`);
      }
      seenIds.set(parsed.id, file);
      entries.push({ config: parsed, file });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { entries, errors };
}

/**
 * Loads deployment.yaml -- hand-edited per environment, like .env (see
 * deployment.yaml.example and .gitignore). Unlike the old per-machine
 * settings.json it replaces (which silently ignored a malformed file and
 * fell back to defaults), a deployment.yaml that EXISTS but fails to
 * parse/validate throws, loudly -- it's a deliberately-authored file now,
 * not an incidental preference, so a mistake in it should stop the server
 * from booting with a wrong/incomplete configuration rather than silently
 * falling back. Returns undefined only when the file doesn't exist at all
 * (a fresh checkout that hasn't created one yet), so the existing
 * CONFIG_DIR/ENDPOINTS_DIR-style env var fallbacks still apply cleanly.
 */
export function loadDeploymentConfig(deploymentFile: string): DeploymentConfigParsed | undefined {
  if (!fs.existsSync(deploymentFile)) return undefined;
  const raw = readStructuredFile(deploymentFile);
  return deploymentConfigSchema.parse(raw);
}

/** Loads gateways.yaml WITHOUT resolving ${env.X} placeholders -- used by
 * the console UI so it can show/preserve "this field references an env var"
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
 * loadGatewaysRaw, for a future console UI. */
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
