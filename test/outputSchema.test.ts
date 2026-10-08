import { describe, expect, it } from "vitest";
import { outputFieldSchema, outputSchema } from "../src/config/schema";

/**
 * Validates src/config/schema.ts's recursive output-field schema directly
 * (mapper.test.ts covers the runtime mapping behavior once a config has
 * already parsed) -- added alongside OutputArrayFieldDef (see its doc
 * comment in src/types/config.ts) for the Developer Console's
 * sample-response JSON-path picker. The important thing this schema has
 * to get right: every endpoint/claims config written before array fields
 * existed has no `kind` on its fields at all, and must keep parsing
 * exactly as it always did.
 */
describe("outputFieldSchema / outputSchema: value vs. array fields", () => {
  it("parses a legacy field with no `kind` as a value field", () => {
    const result = outputFieldSchema.parse({ target: "id", source: "$.id" });
    expect(result).toMatchObject({ target: "id", source: "$.id" });
  });

  it("parses a field with an explicit kind: \"value\"", () => {
    const result = outputFieldSchema.parse({ kind: "value", target: "id", source: "$.id", transform: "trim" });
    expect(result).toMatchObject({ kind: "value", target: "id", source: "$.id", transform: "trim" });
  });

  it("parses a nested array field, including further nested array fields inside it", () => {
    const result = outputFieldSchema.parse({
      kind: "array",
      target: "orders",
      root: "$.orders[*]",
      fields: [
        { target: "id", source: "$.id" },
        { kind: "array", target: "lines", root: "$.lines[*]", fields: [{ target: "sku", source: "$.sku" }] },
      ],
    });
    expect(result).toMatchObject({ kind: "array", target: "orders", root: "$.orders[*]" });
  });

  it("rejects an array field missing root/fields", () => {
    expect(() => outputFieldSchema.parse({ kind: "array", target: "orders" })).toThrow();
  });

  it("rejects a value field missing source", () => {
    expect(() => outputFieldSchema.parse({ target: "id" })).toThrow();
  });

  it("rejects a field that mixes value and array shapes (e.g. both source and root)", () => {
    expect(() => outputFieldSchema.parse({ target: "id", source: "$.id", root: "$.items[*]", fields: [] })).toThrow();
  });

  it("parses a full outputSchema with sibling value and array fields, matching OPS_CONSOLE-style real config shape", () => {
    const result = outputSchema.parse({
      fields: [
        { target: "name", source: "$.name" },
        {
          kind: "array",
          target: "orders",
          root: "$.orders[*]",
          fields: [
            { target: "id", source: "$.id" },
            { target: "amount", source: "$.amount" },
          ],
        },
      ],
    });
    expect(result.fields).toHaveLength(2);
  });

  it("rejects a stray top-level output.root -- that concept was removed in favor of a top-level OutputArrayFieldDef, and outputSchema is strict so a leftover root isn't silently stripped", () => {
    expect(() =>
      outputSchema.parse({
        root: "$.data.customers[*]",
        fields: [{ target: "name", source: "$.name" }],
      })
    ).toThrow();
  });
});

/**
 * Custom transform functions -- see FunctionTransformRef/OutputConfig.
 * postProcess in src/types/config.ts. Schema-level only: it checks the
 * SHAPE of a function reference ({ kind: "function", name }), not
 * whether that name actually resolves to a loaded function -- that's a
 * separate, registry-aware check (see endpointRegistry.ts's
 * reloadFromDisk()/upsert() and src/transform/functionRefs.ts).
 */
describe("outputFieldSchema / outputSchema: custom function references", () => {
  it("parses a field transform that's a function reference instead of one of the built-in enum values", () => {
    const result = outputFieldSchema.parse({
      target: "price",
      source: "$.price",
      transform: { kind: "function", name: "normalizePrice" },
    });
    expect(result).toMatchObject({ target: "price", transform: { kind: "function", name: "normalizePrice" } });
  });

  it("still parses a plain enum transform string the same as before -- the union doesn't force every config to the object shape", () => {
    const result = outputFieldSchema.parse({ target: "id", source: "$.id", transform: "trim" });
    expect(result).toMatchObject({ transform: "trim" });
  });

  it("rejects a function reference missing `name`", () => {
    expect(() =>
      outputFieldSchema.parse({ target: "id", source: "$.id", transform: { kind: "function" } })
    ).toThrow();
  });

  it("rejects a function reference with an unknown `kind`", () => {
    expect(() =>
      outputFieldSchema.parse({ target: "id", source: "$.id", transform: { kind: "bogus", name: "x" } })
    ).toThrow();
  });

  it("parses output.postProcess", () => {
    const result = outputSchema.parse({
      fields: [{ target: "id", source: "$.id" }],
      postProcess: { name: "addComputedTotals" },
    });
    expect(result.postProcess).toEqual({ name: "addComputedTotals" });
  });

  it("output.postProcess is optional -- omitting it parses exactly as before", () => {
    const result = outputSchema.parse({ fields: [{ target: "id", source: "$.id" }] });
    expect(result.postProcess).toBeUndefined();
  });

  it("rejects output.postProcess missing `name`", () => {
    expect(() => outputSchema.parse({ fields: [{ target: "id", source: "$.id" }], postProcess: {} })).toThrow();
  });
});
