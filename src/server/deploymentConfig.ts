import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadDeploymentConfig } from "../config/loader";
import type { DeploymentConfig } from "../types/config";

/**
 * Replaces workspaceSettings.ts -- see WORKSPACE_APPS_DESIGN_NOTES.md.
 * Loaded from deployment.yaml, hand-edited per environment like .env (see
 * deployment.yaml.example and .gitignore), NOT auto-written the way
 * settings.json was. The one exception: the console UI's "Change
 * workspace..." control still updates `configDir` here, exactly as it
 * updated settings.json before -- see saveDeploymentConfigDir() below --
 * but it never touches `mounts`, which stays a hand-edited decision.
 */

export { type DeploymentConfig };

/** Re-exported for callers that just want to read the file -- see
 * config/loader.ts's loadDeploymentConfig for the loud-on-malformed,
 * undefined-only-when-missing behavior. */
export { loadDeploymentConfig };

/**
 * Updates ONLY `configDir` in deployment.yaml, preserving whatever
 * `mounts` list is already there untouched (reading the existing file
 * first, if any, rather than overwriting it wholesale) -- see this
 * module's own doc comment above for why `mounts` is never written here.
 */
export function saveDeploymentConfigDir(deploymentFile: string, configDir: string): void {
  const existing = loadDeploymentConfig(deploymentFile);
  const next: DeploymentConfig = { configDir, mounts: existing?.mounts ?? [] };
  fs.mkdirSync(path.dirname(deploymentFile), { recursive: true });
  fs.writeFileSync(deploymentFile, yaml.dump(next, { lineWidth: 100, noRefs: true }), "utf8");
}

/**
 * A workspace is expected to contain an `integrations/` subfolder (renamed
 * from `endpoints/` -- see WORKSPACE_APPS_DESIGN_NOTES.md), a `gateways.yaml`
 * file, an `authProviders.yaml` file, and now an `apps/` subfolder holding
 * each App's routes -- mirroring this project's own `config/` layout, so
 * pointing the app at one folder resolves every path from a single choice.
 * None has to exist yet: every registry tolerates a missing
 * file/folder (loading as empty) and creates it on first save.
 */
export function resolveConfigDir(
  configDir: string
): { integrationsDir: string; appsDir: string; gatewaysFile: string; authProvidersFile: string; transformsDir: string } {
  return {
    integrationsDir: path.join(configDir, "integrations"),
    appsDir: path.join(configDir, "apps"),
    gatewaysFile: path.join(configDir, "gateways.yaml"),
    authProvidersFile: path.join(configDir, "authProviders.yaml"),
    transformsDir: path.join(configDir, "transforms"),
  };
}
