import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import {
  gatewaysFileSchema,
  gatewayConfigSchema,
  type GatewaysFileParsed,
} from "../config/schema";
import { loadGatewaysRaw } from "../config/loader";
import { substituteEnv } from "../config/envSubst";
import { testSqlConnection } from "../connectors/sql";
import type { SqlGatewayConfig, GatewayConfig } from "../types/config";
import { ValidationError } from "./errors";
import { redact, mergeUnchangedSecrets } from "./secretRedaction";

/**
 * Parses a gateway config, translating a failure into a clear,
 * field-scoped ValidationError instead of the raw ZodError `parse()` would
 * throw. `gatewayConfigSchema` is a plain z.union (not discriminated --
 * `kind` is optional on 3 of its 4 branches), so a naive `parse()` failure
 * surfaces as one opaque top-level "Invalid input" issue with an empty
 * `path`, which the admin UI has nothing to attribute to a specific field.
 * This picks out the branch matching the submitted `kind` (the one whose
 * issues don't include a `kind` mismatch) and reports its field errors.
 */
function parseGatewayConfig(input: unknown): GatewayConfig {
  const result = gatewayConfigSchema.safeParse(input);
  if (result.success) return result.data;

  const kind = input && typeof input === "object" && "kind" in input ? (input as { kind?: unknown }).kind : undefined;
  const topIssue = result.error.issues[0];
  if (topIssue?.code === z.ZodIssueCode.invalid_union) {
    const branch =
      topIssue.unionErrors.find((u) => !u.issues.some((i) => i.path[0] === "kind")) ?? topIssue.unionErrors[0];
    const fieldIssues = branch.issues.filter((i) => i.path.length > 0);
    if (fieldIssues.length > 0) {
      throw new ValidationError(fieldIssues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
  }
  throw new ValidationError(`Invalid gateway config${kind ? ` for kind "${kind}"` : ""}`);
}

/**
 * Holds the current set of named backend gateways in memory, backed by
 * gateways.yaml on disk. Unlike the one-shot loader used at startup, this
 * keeps the RAW (pre-${env.X}-substitution) config around too, so the
 * admin UI can show/preserve "this field references an environment
 * variable" instead of a resolved secret, and so editing one gateway
 * doesn't require re-typing every other one.
 */
export class GatewaysRegistry {
  private raw: GatewaysFileParsed;

  constructor(private filePath: string) {
    this.raw = loadGatewaysRaw(filePath);
  }

  /** The gateways.yaml path this registry is currently reading from/
   * writing to. */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Repoints this registry at a different gateways.yaml and reloads it
   * immediately -- the gateways-side half of the admin UI's "Change
   * folder" feature (see workspaceSettings.ts and EndpointRegistry.setDir()).
   */
  setFilePath(filePath: string): void {
    this.filePath = filePath;
    this.reloadFromDisk();
  }

  reloadFromDisk(): void {
    this.raw = loadGatewaysRaw(this.filePath);
  }

  /** Raw (unsubstituted) gateways, as edited/persisted -- for the admin UI. */
  listRaw(): GatewaysFileParsed["gateways"] {
    return this.raw.gateways;
  }

  getRaw(name: string): unknown {
    return this.raw.gateways[name];
  }

  /** Same shape, with sensitive-looking literal fields masked for display. */
  listRedacted(): GatewaysFileParsed["gateways"] {
    const out: GatewaysFileParsed["gateways"] = {};
    for (const [name, gw] of Object.entries(this.raw.gateways)) {
      out[name] = redact(gw) as (typeof this.raw.gateways)[string];
    }
    return out;
  }

  /** ${env.X}-resolved gateways -- what connectors actually call with. */
  getResolved(): GatewaysFileParsed {
    return gatewaysFileSchema.parse(substituteEnv(this.raw));
  }

  /**
   * Creates or updates a named gateway. For fields matching
   * SENSITIVE_KEY_PATTERN, submitting an empty string keeps the previously
   * stored value (so the UI never needs to round-trip a real secret back
   * to the browser just to leave it alone).
   */
  upsert(name: string, input: unknown): void {
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new ValidationError("Gateway name must contain only letters, digits, _ or -");
    }
    const existing = this.raw.gateways[name];
    const merged = mergeUnchangedSecrets(input, existing);
    const parsed = parseGatewayConfig(merged);

    this.raw = { gateways: { ...this.raw.gateways, [name]: parsed } };
    // Fail fast if this makes an env reference point at an unset variable,
    // rather than only discovering it the next time an endpoint calls it.
    gatewaysFileSchema.parse(substituteEnv(this.raw));
    this.persist();
  }

  /**
   * Tests a gateway's actual reachability -- currently only meaningful for
   * kind: "sql" (runs a trivial query against it). `name`, when given, is
   * an existing gateway being edited: its stored secrets fill in for any
   * sensitive field the draft left blank (the redact/"blank = unchanged"
   * convention the rest of the editor uses), so testing an in-progress
   * edit doesn't require retyping a password that's already saved. Never
   * mutates or persists anything -- the gateway may not even be saved yet.
   */
  async testConnection(name: string | undefined, input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const existing = name ? this.raw.gateways[name] : undefined;
    const merged = mergeUnchangedSecrets(input, existing);
    const parsed = parseGatewayConfig(merged);
    if (!("kind" in parsed) || parsed.kind !== "sql") {
      return { ok: false, message: "Test connection is only available for SQL/database gateways." };
    }
    const resolved = parseGatewayConfig(substituteEnv(parsed)) as SqlGatewayConfig;
    return testSqlConnection(resolved);
  }

  remove(name: string): boolean {
    if (!(name in this.raw.gateways)) return false;
    const { [name]: _removed, ...rest } = this.raw.gateways;
    this.raw = { gateways: rest };
    this.persist();
    return true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, yaml.dump(this.raw, { lineWidth: 100, noRefs: true }), "utf8");
  }
}
