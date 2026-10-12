#!/usr/bin/env -S npx tsx
/**
 * One-time migration -- see WORKSPACE_APPS_DESIGN_NOTES.md's "Hard
 * cutover" decision. Converts every endpoints/*.yaml file (today's
 * Endpoint format: `method`/`path` baked into the same file as
 * `input`/`backend`/`output`) into:
 *   - integrations/<id>.yaml -- the same file, minus `method`/`path`
 *   - one Route entry per endpoint, added to a single default App
 *     (apps/<app-id>.yaml), preserving today's exact URLs: that App gets
 *     mounted at basePath "/" (see the deployment.yaml handling below), so
 *     every existing URL keeps working unchanged.
 *
 * Walks endpoints/ recursively -- the path-mirroring nested layout
 * EndpointRegistry used to maintain is irrelevant now (Integrations and
 * Apps are both flat <id>.yaml files, see integrationFileLayout.ts), so
 * nested folder structure doesn't matter; only each file's own `id` does.
 *
 * Usage:
 *   npx tsx scripts/migrateEndpointsToIntegrations.ts [options]
 *
 *   --config-dir <dir>   Workspace root containing endpoints/ (and where
 *                         integrations/ and apps/ will be written).
 *                         Defaults to this project's own bundled config/.
 *   --app-id <id>        The one App every migrated route lands in.
 *                         Defaults to "default".
 *   --app-name <name>    That App's display name. Defaults to "Default App"
 *                         (or --app-id's value, if --app-id was given).
 *   --dry-run            Report what would happen; writes nothing.
 *   --skip-deployment-mount
 *                         Don't touch deployment.yaml at all -- use this when
 *                         migrating a workspace that isn't necessarily the
 *                         one this naimix instance is currently pointed at
 *                         (e.g. a teammate's separate config-workspace repo).
 *
 * Every Integration and the final App are validated with the real
 * integrationConfigSchema/appConfigSchema (the same ones the server itself
 * uses) before anything is written -- a migrated endpoint that would be
 * invalid, or whose Route would collide (same id, or same method+
 * normalized-path) with one already in the target App, is skipped and
 * reported rather than silently written broken. Safe to re-run: an
 * integration id already on disk, or a route id already in the App, is
 * left untouched rather than overwritten. Never deletes endpoints/*.yaml
 * -- left behind, no longer read by the server once this ships; delete
 * that folder by hand once you've confirmed the migration looks right.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ZodError } from "zod";
import { integrationConfigSchema, appConfigSchema, type AppConfigParsed } from "../src/config/schema";

interface Options {
  configDir: string;
  appId: string;
  appName: string;
  dryRun: boolean;
  skipDeploymentMount: boolean;
}

function parseArgs(argv: string[]): Options {
  let configDir = path.resolve(__dirname, "..", "config");
  let appId = "default";
  let appName = "Default App";
  let appNameExplicit = false;
  let dryRun = false;
  let skipDeploymentMount = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config-dir") configDir = path.resolve(argv[++i]);
    else if (argv[i] === "--app-id") {
      appId = argv[++i];
      if (!appNameExplicit) appName = appId;
    } else if (argv[i] === "--app-name") {
      appName = argv[++i];
      appNameExplicit = true;
    } else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--skip-deployment-mount") skipDeploymentMount = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return { configDir, appId, appName, dryRun, skipDeploymentMount };
}

function findYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findYamlFiles(full));
    else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) results.push(full);
  }
  return results.sort();
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return err instanceof Error ? err.message : String(err);
}

interface OldEndpointConfig {
  id: string;
  description?: string;
  method: string;
  path: string;
  input?: unknown[];
  backend: unknown;
  output: unknown;
}

function looksLikeOldEndpoint(raw: unknown): raw is OldEndpointConfig {
  return (
    !!raw &&
    typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).id === "string" &&
    typeof (raw as Record<string, unknown>).method === "string" &&
    typeof (raw as Record<string, unknown>).path === "string"
  );
}

/**
 * deployment.yaml is otherwise always hand-edited, never auto-written
 * (except its `configDir` field, via the Console's "Change workspace" --
 * see deploymentConfig.ts) -- this is the one deliberate exception: a
 * one-time migration bootstrap, not an ongoing runtime behavior. If
 * DEPLOYMENT_FILE doesn't exist at all yet, seeds it with exactly what's
 * needed to serve what was just migrated, at the same URLs as before
 * (basePath "/"). If it already exists, never touches it -- just tells
 * you what to add by hand.
 */
function ensureDeploymentMount(configDir: string, appId: string): void {
  const deploymentFile = path.resolve(process.cwd(), process.env.DEPLOYMENT_FILE ?? "deployment.yaml");

  type ParsedDeployment = { configDir?: string; mounts?: { app: string; basePath: string }[] };
  if (fs.existsSync(deploymentFile)) {
    let existing: ParsedDeployment | null = null;
    try {
      existing = (yaml.load(fs.readFileSync(deploymentFile, "utf8")) ?? null) as ParsedDeployment | null;
    } catch {
      // Malformed -- same as the server's own loadDeploymentConfig, this is
      // a loud problem but not this script's to fix; just fall through to
      // telling the user what to add.
    }
    const mounts = existing?.mounts ?? [];
    if (mounts.some((m) => m.app === appId)) {
      console.log(`\n${deploymentFile} already mounts app "${appId}" -- left untouched.`);
      return;
    }
    console.log(
      `\n${deploymentFile} exists but has no mount for app "${appId}" yet. deployment.yaml's \`mounts\` list is ` +
        `always hand-edited (see WORKSPACE_APPS_DESIGN_NOTES.md) -- add this entry yourself:\n` +
        `  - app: ${appId}\n    basePath: /\n`
    );
    return;
  }

  const deployment = {
    configDir: path.relative(process.cwd(), configDir) || ".",
    mounts: [{ app: appId, basePath: "/" }],
  };
  fs.writeFileSync(deploymentFile, yaml.dump(deployment, { lineWidth: 100, noRefs: true }), "utf8");
  console.log(
    `\nCreated ${deploymentFile}, mounting app "${appId}" at basePath "/" (your existing URLs keep working unchanged).`
  );
}

function main(): void {
  const { configDir, appId, appName, dryRun, skipDeploymentMount } = parseArgs(process.argv.slice(2));
  const endpointsDir = path.join(configDir, "endpoints");
  const integrationsDir = path.join(configDir, "integrations");
  const appsDir = path.join(configDir, "apps");

  if (!fs.existsSync(endpointsDir)) {
    console.log(`No endpoints/ folder at ${endpointsDir} -- nothing to migrate.`);
    return;
  }

  const files = findYamlFiles(endpointsDir);
  if (files.length === 0) {
    console.log(`${endpointsDir} has no .yaml files -- nothing to migrate.`);
    return;
  }

  const appFile = path.join(appsDir, `${appId}.yaml`);
  let appConfig: AppConfigParsed;
  if (fs.existsSync(appFile)) {
    try {
      appConfig = appConfigSchema.parse(yaml.load(fs.readFileSync(appFile, "utf8")));
    } catch (err) {
      console.error(`Can't continue: ${appFile} already exists but isn't a valid App config -- ${describeError(err)}`);
      process.exitCode = 1;
      return;
    }
  } else {
    appConfig = appConfigSchema.parse({ id: appId, name: appName, routes: [] });
  }
  const existingRouteIds = new Set(appConfig.routes.map((r) => r.id));

  let migrated = 0;
  let skipped = 0;

  for (const file of files) {
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`SKIP ${file}: couldn't parse YAML -- ${describeError(err)}`);
      skipped++;
      continue;
    }
    if (!looksLikeOldEndpoint(raw)) {
      console.error(`SKIP ${file}: doesn't look like a valid endpoint config (missing id/method/path)`);
      skipped++;
      continue;
    }
    const endpoint = raw;

    if (existingRouteIds.has(endpoint.id)) {
      console.error(`SKIP ${file}: app "${appId}" already has a route "${endpoint.id}" -- not overwriting`);
      skipped++;
      continue;
    }
    const integrationFile = path.join(integrationsDir, `${endpoint.id}.yaml`);
    if (fs.existsSync(integrationFile)) {
      console.error(`SKIP ${file}: integrations/${endpoint.id}.yaml already exists -- not overwriting`);
      skipped++;
      continue;
    }

    let integration;
    try {
      integration = integrationConfigSchema.parse({
        id: endpoint.id,
        ...(endpoint.description ? { description: endpoint.description } : {}),
        ...(endpoint.input && endpoint.input.length > 0 ? { input: endpoint.input } : {}),
        backend: endpoint.backend,
        output: endpoint.output,
      });
    } catch (err) {
      console.error(`SKIP ${file}: wouldn't be a valid Integration -- ${describeError(err)}`);
      skipped++;
      continue;
    }

    const candidateApp = {
      ...appConfig,
      routes: [
        ...appConfig.routes,
        {
          id: endpoint.id,
          method: endpoint.method,
          path: endpoint.path,
          ...(endpoint.description ? { description: endpoint.description } : {}),
          integration: integration.id,
        },
      ],
    };

    let parsedApp: AppConfigParsed;
    try {
      parsedApp = appConfigSchema.parse(candidateApp);
    } catch (err) {
      console.error(`SKIP ${file}: its Route would collide in app "${appId}" -- ${describeError(err)}`);
      skipped++;
      continue;
    }

    if (!dryRun) {
      fs.mkdirSync(integrationsDir, { recursive: true });
      fs.writeFileSync(integrationFile, yaml.dump(integration, { lineWidth: 100, noRefs: true }), "utf8");
    }
    appConfig = parsedApp;
    existingRouteIds.add(endpoint.id);
    migrated++;
    console.log(
      `MIGRATED ${file} -> integrations/${endpoint.id}.yaml + app "${appId}" route ${endpoint.method} ${endpoint.path}`
    );
  }

  if (!dryRun && migrated > 0) {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(appFile, yaml.dump(appConfig, { lineWidth: 100, noRefs: true }), "utf8");
  }

  console.log(`\n${migrated} migrated, ${skipped} skipped.`);
  if (dryRun) {
    console.log("(--dry-run: no files were written)");
    return;
  }
  if (migrated === 0) return;

  if (skipDeploymentMount) {
    console.log(
      `\ndeployment.yaml was left untouched (--skip-deployment-mount). If you want this instance to serve ` +
        `app "${appId}" from ${configDir}, point deployment.yaml's configDir at it and add this to its ` +
        `\`mounts\` list by hand:\n  - app: ${appId}\n    basePath: /\n`
    );
  } else {
    ensureDeploymentMount(configDir, appId);
  }

  console.log(
    `\n${endpointsDir} was left untouched (no longer read once this ships -- see WORKSPACE_APPS_DESIGN_NOTES.md's ` +
      `"Hard cutover"). Delete it by hand once you've confirmed the migration looks right.`
  );
}

main();
