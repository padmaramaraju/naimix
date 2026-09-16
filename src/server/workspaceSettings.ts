import fs from "node:fs";
import path from "node:path";

/**
 * This project is meant to run as one process per person (see README/
 * TECHNICAL.md "Workspace") -- each user keeps their own checkout of a
 * team's endpoints/gateways Git repo on disk, and points their own local
 * instance at it (their "workspace"). There is no login system and no
 * concept of multiple users sharing one running server: "which workspace
 * is active" is a single, per-machine setting, not a per-request one.
 */
export interface WorkspaceSettings {
  /** Path to the workspace -- a folder containing an `endpoints/`
   * subfolder and a `gateways.yaml` file, typically a local Git checkout.
   * The admin UI's "Change workspace" control always saves an absolute
   * path (see adminApi.ts), since it's meant to point at an arbitrary
   * folder anywhere on disk; a relative path also works (resolved against
   * process.cwd() at startup -- see index.ts's resolveStartupPaths()) for
   * the common case of pointing at this project's own bundled `config/`
   * folder, so a checkout stays self-contained without a hand-set absolute
   * path baked in. Persisted/transmitted under the field name `configDir`
   * -- a stable data contract (this settings file, the /admin/api/settings
   * API, the "Change workspace" form field) that's independent of the
   * user-facing "workspace" name. */
  configDir: string;
}

/**
 * Reads the locally-persisted "which workspace is this machine currently
 * pointed at" preference, if one has ever been saved (via the admin UI's
 * "Change workspace" control). Deliberately lives OUTSIDE any workspace
 * itself -- since the whole point is that the workspace can be swapped for
 * a different Git checkout entirely, this file has to survive that swap.
 * Not something a team would check into Git: it is a per-machine
 * preference, not shared project config.
 */
export function loadWorkspaceSettings(settingsFile: string): WorkspaceSettings | undefined {
  if (!fs.existsSync(settingsFile)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (raw && typeof raw.configDir === "string" && raw.configDir.trim() !== "") {
      return { configDir: raw.configDir };
    }
  } catch {
    // Malformed/corrupted local settings file -- ignore it and fall back to
    // the default/env-var config location rather than failing startup over
    // a preference file that isn't essential to have.
  }
  return undefined;
}

export function saveWorkspaceSettings(settingsFile: string, settings: WorkspaceSettings): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/**
 * A workspace is expected to contain an `endpoints/` subfolder and a
 * `gateways.yaml` file, mirroring this project's own `config/` layout --
 * so pointing the app at one folder resolves both paths from a single
 * choice. Neither has to exist yet: `EndpointRegistry`/`GatewaysRegistry`
 * already tolerate a missing endpoints dir or gateways file (loading as
 * empty), and create them on first save -- useful for a brand-new, still-
 * empty team repo.
 */
export function resolveConfigDir(configDir: string): { endpointsDir: string; gatewaysFile: string } {
  return {
    endpointsDir: path.join(configDir, "endpoints"),
    gatewaysFile: path.join(configDir, "gateways.yaml"),
  };
}
