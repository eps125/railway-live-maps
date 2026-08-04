import { describe, expect, it } from "vitest";
import { computeSemanticHash } from "./semanticHash.js";

describe("computeSemanticHash", () => {
  it("is deterministic for identical input", () => {
    const input = { CA_MSG: { area_id: "ZZ", descr: "2A16" } };
    expect(computeSemanticHash(input)).toBe(computeSemanticHash({ ...input }));
  });

  it("differs for different input", () => {
    expect(computeSemanticHash({ a: 1 })).not.toBe(computeSemanticHash({ a: 2 }));
  });
});
