import { describe, expect, it } from "vitest";
import { inferSClassKind, parseSClassDefinitionTable } from "./sClassDefinitions.js";

/** Excerpt of the real R3 table (Open Rail Data wiki, as pasted by the owner 2026-09-19): hex
 * addresses in `ADDR:BIT` form, `?` for seen-but-unidentified, and a genuine duplicate (S3533 on
 * both 1A:3 and 26:3). */
const R3 = [
  "Address\tFunction\tDestination",
  "00:0\t?\t",
  "00:3\t\t",
  "03:0\tS3471\t",
  "03:1\tS3473\t",
  "0A:0\tS3472\t",
  "1A:3\tS3533\t",
  "26:3\tS3533\t",
  "2E:3\tS5549\t",
].join("\n");

/** Excerpt of the real M8 table: decimal byte numbers in their own column, routes with
 * destinations (including ones containing spaces). */
const M8 = [
  "Byte\tBit\tFunction\tDestination",
  "0\t0\tR1007\tIL1021",
  "2\t6\tR1024\tBerth ULLS",
  "15\t4\tR1036\tSouth Yard (IL1049)",
  "25\t1\tS3037\t",
  "25\t7\t\t",
  "37\t0\t?\t",
].join("\n");

describe("parseSClassDefinitionTable", () => {
  it("R3 (hex, ADDR:BIT): parses, skips ?/blank, and flags the S3533 duplicate", () => {
    const result = parseSClassDefinitionTable(R3, "hex");
    expect(result.definitions.map((d) => [d.address, d.bit, d.kind, d.label])).toEqual([
      ["03", 0, "signal", "S3471"],
      ["03", 1, "signal", "S3473"],
      ["0A", 0, "signal", "S3472"],
      ["1A", 3, "signal", "S3533"],
      ["26", 3, "signal", "S3533"],
      ["2E", 3, "signal", "S5549"],
    ]);
    expect(result.skippedUnidentified).toBe(2);
    expect(result.ignoredLines).toBe(1); // the header
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ line: 8, code: "duplicate_label" }),
    ]);
  });

  it("M8 (decimal, BYTE BIT): byte 25 is address 0x19; routes keep destinations with spaces", () => {
    const result = parseSClassDefinitionTable(M8, "decimal");
    expect(
      result.definitions.map((d) => [d.address, d.bit, d.kind, d.label, d.destination]),
    ).toEqual([
      ["00", 0, "route", "R1007", "IL1021"],
      ["02", 6, "route", "R1024", "Berth ULLS"],
      ["0F", 4, "route", "R1036", "South Yard (IL1049)"],
      ["19", 1, "signal", "S3037", null],
    ]);
    expect(result.skippedUnidentified).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it("never guesses the radix: the same M8 rows read as hex land on different bytes", () => {
    // "25" read as hex is 0x25, not 0x19 — which is exactly why the caller must choose.
    const asHex = parseSClassDefinitionTable("25\t1\tS3037", "hex");
    expect(asHex.definitions[0]?.address).toBe("25");
  });

  it("a token invalid in the chosen radix is an error, not reinterpreted", () => {
    const result = parseSClassDefinitionTable("0A:0\tS3472", "decimal");
    expect(result.definitions).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ line: 1, code: "invalid_address" })]);
  });

  it("rejects a bit outside 0-7 and a byte over 255", () => {
    const result = parseSClassDefinitionTable("03:8\tS1\n300\t1\tS2", "decimal");
    // "03" is a valid decimal byte with an invalid bit 8; "300" is past 255.
    expect(result.errors.map((e) => e.code)).toEqual(["invalid_bit", "invalid_address"]);
    const hex = parseSClassDefinitionTable("03:8\tS1", "hex");
    expect(hex.errors.map((e) => e.code)).toEqual(["invalid_bit"]);
  });

  it("the same bit defined twice in one import is an error", () => {
    const result = parseSClassDefinitionTable("03:0\tS1\n03:0\tS2", "hex");
    expect(result.errors).toEqual([expect.objectContaining({ line: 2, code: "duplicate_bit" })]);
  });
});

describe("inferSClassKind", () => {
  it("S = signal, R = route, anything else unknown", () => {
    expect(inferSClassKind("S3003")).toBe("signal");
    expect(inferSClassKind("R1007")).toBe("route");
    expect(inferSClassKind("TRTS1")).toBe("unknown");
  });
});
