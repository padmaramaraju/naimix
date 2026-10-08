import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapResponse } from "../src/transform/mapper";
import { FunctionRegistry } from "../src/transform/functionRegistry";
import type { OutputConfig } from "../src/types/config";

/** A real FunctionRegistry backed by a throwaway transforms/ folder --
 * function-kind transform/postProcess resolution goes through the actual
 * require()/require.cache machinery (see functionRegistry.ts), not a
 * hand-rolled stand-in, since that machinery is exactly what this
 * coverage needs to exercise. */
const FUNCTIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "naimix-mapper-functions-"));
function defineFunction(name: string, body: string): FunctionRegistry {
  fs.writeFileSync(path.join(FUNCTIONS_DIR, `${name}.js`), `module.exports = ${body};\n`, "utf8");
  const registry = new FunctionRegistry(FUNCTIONS_DIR);
  registry.loadFromDisk();
  return registry;
}
afterAll(() => {
  fs.rmSync(FUNCTIONS_DIR, { recursive: true, force: true });
});

describe("mapResponse", () => {
  it("maps a single object response into a nested output shape", () => {
    const response = { id: "7", firstName: "Ada", lastName: "Lovelace", address: { city: "London" } };
    const output: OutputConfig = {
      fields: [
        { target: "customerId", source: "$.id" },
        { target: "name.first", source: "$.firstName" },
        { target: "name.last", source: "$.lastName" },
        { target: "location.city", source: "$.address.city" },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      customerId: "7",
      name: { first: "Ada", last: "Lovelace" },
      location: { city: "London" },
    });
  });

  it("applies the default when the source path has no match", () => {
    const output: OutputConfig = {
      fields: [{ target: "country", source: "$.address.country", default: "Unknown" }],
    };
    expect(mapResponse({}, output)).toEqual({ country: "Unknown" });
  });

  it("applies field transforms", () => {
    const output: OutputConfig = {
      fields: [
        { target: "status", source: "$.status", transform: "lower" },
        { target: "count", source: "$.count", transform: "toNumber" },
        { target: "flag", source: "$.flag", transform: "toBoolean" },
      ],
    };
    expect(mapResponse({ status: "ACTIVE", count: "3", flag: "true" }, output)).toEqual({
      status: "active",
      count: 3,
      flag: true,
    });
  });

  it("maps a top-level array via an OutputArrayFieldDef -- there's no separate output.root anymore, a field that needs to be a list is just a named array field like any other", () => {
    const response = {
      items: [
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ],
    };
    const output: OutputConfig = {
      fields: [
        {
          kind: "array",
          target: "items",
          root: "$.items[*]",
          fields: [
            { target: "id", source: "$.id" },
            { target: "name", source: "$.name" },
          ],
        },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      items: [
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ],
    });
  });

  it("indexes into a top-level array response without output.root", () => {
    const response = [{ id: "1", first_name: "Ada" }];
    const output: OutputConfig = {
      fields: [{ target: "id", source: "$[0].id" }],
    };
    expect(mapResponse(response, output)).toEqual({ id: "1" });

/**
 * OutputArrayFieldDef ("kind: array") coverage -- nested/multiple
 * collections inside one output, added for the Developer Console's
 * sample-response JSON-path picker (right-click/"+" on a field in the
 * Test tab's fetched sample). See OutputArrayFieldDef's doc comment in
 * src/types/config.ts and mapItem()'s own comment in src/transform/mapper.ts.
 */
describe("mapResponse / mapItem: nested array fields (OutputArrayFieldDef)", () => {
  it("maps a single array field alongside plain value fields", () => {
    const response = {
      name: "Acme Corp",
      tags: [
        { id: "t1", label: "vip" },
        { id: "t2", label: "slow-pay" },
      ],
    };
    const output: OutputConfig = {
      fields: [
        { target: "name", source: "$.name" },
        {
          kind: "array",
          target: "tags",
          root: "$.tags[*]",
          fields: [
            { target: "id", source: "$.id" },
            { target: "label", source: "$.label" },
          ],
        },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      name: "Acme Corp",
      tags: [
        { id: "t1", label: "vip" },
        { id: "t2", label: "slow-pay" },
      ],
    });
  });

  it("maps arrays nested inside arrays, e.g. customers[].orders[]", () => {
    const response = {
      customers: [
        {
          name: "Ada",
          orders: [
            { id: "o1", amount: 10 },
            { id: "o2", amount: 20 },
          ],
        },
        { name: "Grace", orders: [{ id: "o3", amount: 30 }] },
      ],
    };
    const output: OutputConfig = {
      root: "$.customers[*]",
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
    };
    expect(mapResponse(response, output)).toEqual([
      {
        name: "Ada",
        orders: [
          { id: "o1", amount: 10 },
          { id: "o2", amount: 20 },
        ],
      },
      { name: "Grace", orders: [{ id: "o3", amount: 30 }] },
    ]);
  });

  it("maps multiple sibling arrays inside the same item", () => {
    const response = { tags: [{ id: "t1" }], notes: [{ id: "n1" }, { id: "n2" }] };
    const output: OutputConfig = {
      fields: [
        { kind: "array", target: "tags", root: "$.tags[*]", fields: [{ target: "id", source: "$.id" }] },
        { kind: "array", target: "notes", root: "$.notes[*]", fields: [{ target: "id", source: "$.id" }] },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      tags: [{ id: "t1" }],
      notes: [{ id: "n1" }, { id: "n2" }],
    });
  });

  it("produces an empty array, not an error, when an array field's root has no matches", () => {
    const output: OutputConfig = {
      fields: [{ kind: "array", target: "items", root: "$.items[*]", fields: [{ target: "id", source: "$.id" }] }],
    };
    expect(mapResponse({}, output)).toEqual({ items: [] });
  });

  it("still treats a field with no `kind` as a value field -- backward compatible with every config written before array fields existed", () => {
    const output: OutputConfig = {
      fields: [{ target: "id", source: "$.id" }],
    };
    expect(mapResponse({ id: "7" }, output)).toEqual({ id: "7" });
  });
});
  });

/**
 * OutputArrayFieldDef ("kind: array") coverage -- nested/multiple
 * collections inside one output, added for the Developer Console's
 * sample-response JSON-path picker (right-click/"+" on a field in the
 * Test tab's fetched sample). See OutputArrayFieldDef's doc comment in
 * src/types/config.ts and mapItem()'s own comment in src/transform/mapper.ts.
 */
describe("mapResponse / mapItem: nested array fields (OutputArrayFieldDef)", () => {
  it("maps a single array field alongside plain value fields", () => {
    const response = {
      name: "Acme Corp",
      tags: [
        { id: "t1", label: "vip" },
        { id: "t2", label: "slow-pay" },
      ],
    };
    const output: OutputConfig = {
      fields: [
        { target: "name", source: "$.name" },
        {
          kind: "array",
          target: "tags",
          root: "$.tags[*]",
          fields: [
            { target: "id", source: "$.id" },
            { target: "label", source: "$.label" },
          ],
        },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      name: "Acme Corp",
      tags: [
        { id: "t1", label: "vip" },
        { id: "t2", label: "slow-pay" },
      ],
    });
  });

  it("maps arrays nested inside arrays, e.g. customers[].orders[]", () => {
    const response = {
      customers: [
        {
          name: "Ada",
          orders: [
            { id: "o1", amount: 10 },
            { id: "o2", amount: 20 },
          ],
        },
        { name: "Grace", orders: [{ id: "o3", amount: 30 }] },
      ],
    };
    const output: OutputConfig = {
      root: "$.customers[*]",
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
    };
    expect(mapResponse(response, output)).toEqual([
      {
        name: "Ada",
        orders: [
          { id: "o1", amount: 10 },
          { id: "o2", amount: 20 },
        ],
      },
      { name: "Grace", orders: [{ id: "o3", amount: 30 }] },
    ]);
  });

  it("maps multiple sibling arrays inside the same item", () => {
    const response = { tags: [{ id: "t1" }], notes: [{ id: "n1" }, { id: "n2" }] };
    const output: OutputConfig = {
      fields: [
        { kind: "array", target: "tags", root: "$.tags[*]", fields: [{ target: "id", source: "$.id" }] },
        { kind: "array", target: "notes", root: "$.notes[*]", fields: [{ target: "id", source: "$.id" }] },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      tags: [{ id: "t1" }],
      notes: [{ id: "n1" }, { id: "n2" }],
    });
  });

  it("produces an empty array, not an error, when an array field's root has no matches", () => {
    const output: OutputConfig = {
      fields: [{ kind: "array", target: "items", root: "$.items[*]", fields: [{ target: "id", source: "$.id" }] }],
    };
    expect(mapResponse({}, output)).toEqual({ items: [] });
  });

  it("still treats a field with no `kind` as a value field -- backward compatible with every config written before array fields existed", () => {
    const output: OutputConfig = {
      fields: [{ target: "id", source: "$.id" }],
    };
    expect(mapResponse({ id: "7" }, output)).toEqual({ id: "7" });
  });
});
});

/**
 * OutputArrayFieldDef ("kind: array") coverage -- nested/multiple
 * collections inside one output, added for the Developer Console's
 * sample-response JSON-path picker (right-click/"+" on a field in the
 * Test tab's fetched sample). See OutputArrayFieldDef's doc comment in
 * src/types/config.ts and mapItem()'s own comment in src/transform/mapper.ts.
 */
describe("mapResponse / mapItem: nested array fields (OutputArrayFieldDef)", () => {
  it("maps a single array field alongside plain value fields", () => {
    const response = {
      name: "Acme Corp",
      tags: [
        { id: "t1", label: "vip" },
        { id: "t2", label: "slow-pay" },
      ],
    };
    const output: OutputConfig = {
      fields: [
        { target: "name", source: "$.name" },
        {
          kind: "array",
          target: "tags",
          root: "$.tags[*]",
          fields: [
            { target: "id", source: "$.id" },
            { target: "label", source: "$.label" },
          ],
        },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      name: "Acme Corp",
      tags: [
        { id: "t1", label: "vip" },
        { id: "t2", label: "slow-pay" },
      ],
    });
  });

  it("maps arrays nested inside arrays, e.g. customers[].orders[]", () => {
    const response = {
      customers: [
        {
          name: "Ada",
          orders: [
            { id: "o1", amount: 10 },
            { id: "o2", amount: 20 },
          ],
        },
        { name: "Grace", orders: [{ id: "o3", amount: 30 }] },
      ],
    };
    const output: OutputConfig = {
      root: "$.customers[*]",
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
    };
    expect(mapResponse(response, output)).toEqual([
      {
        name: "Ada",
        orders: [
          { id: "o1", amount: 10 },
          { id: "o2", amount: 20 },
        ],
      },
      { name: "Grace", orders: [{ id: "o3", amount: 30 }] },
    ]);
  });

  it("maps multiple sibling arrays inside the same item", () => {
    const response = { tags: [{ id: "t1" }], notes: [{ id: "n1" }, { id: "n2" }] };
    const output: OutputConfig = {
      fields: [
        { kind: "array", target: "tags", root: "$.tags[*]", fields: [{ target: "id", source: "$.id" }] },
        { kind: "array", target: "notes", root: "$.notes[*]", fields: [{ target: "id", source: "$.id" }] },
      ],
    };
    expect(mapResponse(response, output)).toEqual({
      tags: [{ id: "t1" }],
      notes: [{ id: "n1" }, { id: "n2" }],
    });
  });

  it("produces an empty array, not an error, when an array field's root has no matches", () => {
    const output: OutputConfig = {
      fields: [{ kind: "array", target: "items", root: "$.items[*]", fields: [{ target: "id", source: "$.id" }] }],
    };
    expect(mapResponse({}, output)).toEqual({ items: [] });
  });

  it("still treats a field with no `kind` as a value field -- backward compatible with every config written before array fields existed", () => {
    const output: OutputConfig = {
      fields: [{ target: "id", source: "$.id" }],
    };
    expect(mapResponse({ id: "7" }, output)).toEqual({ id: "7" });
  });
});


/**
 * Custom transform functions -- see FunctionTransformRef/OutputConfig.
 * postProcess in src/types/config.ts and FunctionRegistry's own doc
 * comment for the design. Covers both hook points mapper.ts exposes:
 * a field-level `transform: { kind: "function", name }` (one value in,
 * one value out) and an endpoint-level `output.postProcess` (the whole
 * mapped result in, a replacement whole result out).
 */
describe("mapResponse / mapItem: custom transform functions", () => {
  it("applies a field-level function transform, passing (value, { item, raw, params })", () => {
    const registry = defineFunction(
      "shout",
      "function (value, ctx) { return String(value).toUpperCase() + \"!\" + (ctx.params?.suffix || \"\"); }"
    );
    const output: OutputConfig = {
      fields: [{ target: "greeting", source: "$.msg", transform: { kind: "function", name: "shout" } }],
    };
    const result = mapResponse({ msg: "hello" }, output, { functions: registry, params: { suffix: "?" } });
    expect(result).toEqual({ greeting: "HELLO!?" });
  });

  it("a field-level function returning undefined omits the field, same as any other value field", () => {
    const registry = defineFunction("dropIt", "function (_value, _ctx) { return undefined; }");
    const output: OutputConfig = {
      fields: [
        { target: "kept", source: "$.a" },
        { target: "dropped", source: "$.b", transform: { kind: "function", name: "dropIt" } },
      ],
    };
    expect(mapResponse({ a: 1, b: 2 }, output, { functions: registry })).toEqual({ kept: 1 });
  });

  it("throws a clear error when a field-level function name isn't in the registry (should never happen past config validation, but fails loudly rather than silently)", () => {
    const output: OutputConfig = {
      fields: [{ target: "x", source: "$.x", transform: { kind: "function", name: "doesNotExist" } }],
    };
    expect(() => mapResponse({ x: 1 }, output, { functions: new FunctionRegistry(FUNCTIONS_DIR) })).toThrow(
      /doesNotExist/
    );
  });

  it("applies output.postProcess once on the whole mapped result, with ctx.raw set to the original response", () => {
    const registry = defineFunction(
      "addTotal",
      "function (mapped, ctx) { return { ...mapped, total: mapped.items.length, sawRaw: !!ctx.raw }; }"
    );
    const output: OutputConfig = {
      fields: [{ kind: "array", target: "items", root: "$.rows[*]", fields: [{ target: "id", source: "$.id" }] }],
      postProcess: { name: "addTotal" },
    };
    const result = mapResponse({ rows: [{ id: "a" }, { id: "b" }] }, output, { functions: registry });
    expect(result).toEqual({ items: [{ id: "a" }, { id: "b" }], total: 2, sawRaw: true });
  });

  it("postProcess runs ONCE on the whole mapped object even when one of its fields is itself a list -- not once per list item", () => {
    const registry = defineFunction(
      "tagEach",
      "function (mapped, _ctx) { return { ...mapped, rows: mapped.rows.map((m) => ({ ...m, tagged: true })) }; }"
    );
    const output: OutputConfig = {
      fields: [{ kind: "array", target: "rows", root: "$.rows[*]", fields: [{ target: "id", source: "$.id" }] }],
      postProcess: { name: "tagEach" },
    };
    const result = mapResponse({ rows: [{ id: "a" }, { id: "b" }] }, output, { functions: registry });
    expect(result).toEqual({
      rows: [
        { id: "a", tagged: true },
        { id: "b", tagged: true },
      ],
    });
  });

  it("the same function name can be referenced from a field's transform AND from postProcess -- no separate 'field-only'/'endpoint-only' registry concept", () => {
    const registry = defineFunction("double", "function (v) { return typeof v === \"number\" ? v * 2 : v; }");
    const fieldOutput: OutputConfig = {
      fields: [{ target: "a", source: "$.a", transform: { kind: "function", name: "double" } }],
    };
    expect(mapResponse({ a: 3 }, fieldOutput, { functions: registry })).toEqual({ a: 6 });

    const postProcessOutput: OutputConfig = {
      fields: [{ target: "count", source: "$.count" }],
      postProcess: { name: "double" },
    };
    // The whole mapped object isn't a number, so "double" passes it through
    // unchanged (its own `typeof v === "number"` guard) -- what matters
    // here is that the SAME registered function resolves for both roles.
    expect(mapResponse({ count: 5 }, postProcessOutput, { functions: registry })).toEqual({ count: 5 });
  });
});
