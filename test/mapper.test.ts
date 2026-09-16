import { describe, expect, it } from "vitest";
import { mapResponse } from "../src/transform/mapper";
import type { OutputConfig } from "../src/types/config";

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

  it("maps an array response item-by-item via output.root", () => {
    const response = {
      items: [
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ],
    };
    const output: OutputConfig = {
      root: "$.items[*]",
      fields: [
        { target: "id", source: "$.id" },
        { target: "name", source: "$.name" },
      ],
    };
    expect(mapResponse(response, output)).toEqual([
      { id: "1", name: "Ada" },
      { id: "2", name: "Grace" },
    ]);
  });

  it("indexes into a top-level array response without output.root", () => {
    const response = [{ id: "1", first_name: "Ada" }];
    const output: OutputConfig = {
      fields: [{ target: "id", source: "$[0].id" }],
    };
    expect(mapResponse(response, output)).toEqual({ id: "1" });
  });
});
