import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { extractParams } from "../src/server/paramExtractor";
import { ValidationError } from "../src/server/errors";
import type { InputParamDef } from "../src/types/config";

function fakeRequest(overrides: Partial<Request>): Request {
  return {
    params: {},
    query: {},
    headers: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

describe("extractParams", () => {
  it("extracts and coerces path/query/header/body params by declared type", () => {
    const input: InputParamDef[] = [
      { name: "id", in: "path", required: true, type: "string" },
      { name: "limit", in: "query", required: false, type: "number" },
      { name: "x-trace", in: "header", required: false, type: "string" },
      { name: "active", in: "body", required: false, type: "boolean" },
    ];
    const req = fakeRequest({
      params: { id: "42" },
      query: { limit: "10" },
      headers: { "x-trace": "abc123" },
      body: { active: "true" },
    });

    const result = extractParams(input, req);
    expect(result).toEqual({ id: "42", limit: 10, "x-trace": "abc123", active: true });
  });

  it("applies the default value when a param is absent", () => {
    const input: InputParamDef[] = [
      { name: "page", in: "query", required: false, type: "number", default: 1 },
    ];
    const result = extractParams(input, fakeRequest({}));
    expect(result).toEqual({ page: 1 });
  });

  it("throws ValidationError when a required param is missing", () => {
    const input: InputParamDef[] = [{ name: "id", in: "path", required: true, type: "string" }];
    expect(() => extractParams(input, fakeRequest({ params: {} }))).toThrow(ValidationError);
  });

  it("throws ValidationError when a numeric param can't be coerced", () => {
    const input: InputParamDef[] = [{ name: "limit", in: "query", required: true, type: "number" }];
    expect(() => extractParams(input, fakeRequest({ query: { limit: "not-a-number" } }))).toThrow(
      ValidationError
    );
  });

  it("silently skips an optional param with no default and no value", () => {
    const input: InputParamDef[] = [{ name: "q", in: "query", required: false, type: "string" }];
    const result = extractParams(input, fakeRequest({}));
    expect(result).toEqual({});
  });
});
