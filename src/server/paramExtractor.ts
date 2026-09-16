import type { Request } from "express";
import type { InputParamDef } from "../types/config";
import type { ResolvedParams } from "../connectors/paramSubst";
import { ValidationError } from "./errors";

function coerce(raw: unknown, type: InputParamDef["type"], name: string): string | number | boolean {
  switch (type) {
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new ValidationError(`Parameter "${name}" must be a number, got "${raw}"`);
      }
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new ValidationError(`Parameter "${name}" must be a boolean, got "${raw}"`);
    case "string":
    default:
      return String(raw);
  }
}

export function extractParams(input: InputParamDef[], req: Request): ResolvedParams {
  const result: ResolvedParams = {};

  for (const p of input) {
    let raw: unknown;
    switch (p.in) {
      case "path":
        raw = req.params[p.name];
        break;
      case "query":
        raw = req.query[p.name];
        break;
      case "header":
        raw = req.headers[p.name.toLowerCase()];
        break;
      case "body":
        raw = req.body ? (req.body as Record<string, unknown>)[p.name] : undefined;
        break;
      case "env":
        // Not supplied by the caller at all -- sourced from this process's
        // own environment, e.g. a shared API key endpoints shouldn't expose.
        raw = process.env[p.envVar || p.name];
        break;
    }

    if (raw === undefined || raw === "") {
      if (p.default !== undefined) {
        result[p.name] = p.default;
        continue;
      }
      if (p.required) {
        throw new ValidationError(`Missing required ${p.in} parameter "${p.name}"`);
      }
      continue;
    }

    result[p.name] = coerce(raw, p.type, p.name);
  }

  return result;
}
