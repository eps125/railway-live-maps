import { describe, expect, it } from "vitest";
import { liveTdStatus, parseOutageDays } from "./outages.js";

const NOW = new Date("2026-10-30T12:00:00Z");

describe("parseOutageDays", () => {
  it("defaults to 30 and accepts whole days from 1 to 365", () => {
    expect(parseOutageDays(undefined)).toBe(30);
    expect(parseOutageDays("")).toBe(30);
    expect(parseOutageDays("7")).toBe(7);
    expect(parseOutageDays("365")).toBe(365);
  });

  it("rejects anything else", () => {
    for (const raw of ["0", "366", "2.5", "-1", "week", "7d"]) {
      expect(parseOutageDays(raw)).toBeNull();
    }
  });
});

describe("liveTdStatus", () => {
  it("is not ongoing while frames keep arriving", () => {
    expect(liveTdStatus(new Date("2026-10-30T11:59:30Z"), NOW)).toEqual({
      lastFrameAt: "2026-10-30T11:59:30.000Z",
      silentForSeconds: 30,
      ongoing: false,
    });
  });

  it("is ongoing once TD has been silent longer than the gap tolerance (5 minutes)", () => {
    expect(liveTdStatus(new Date("2026-10-30T11:55:00Z"), NOW).ongoing).toBe(false);
    expect(liveTdStatus(new Date("2026-10-30T11:54:59Z"), NOW)).toMatchObject({
      silentForSeconds: 301,
      ongoing: true,
    });
  });

  it("counts a feed that has never received anything as silent", () => {
    expect(liveTdStatus(null, NOW)).toEqual({
      lastFrameAt: null,
      silentForSeconds: null,
      ongoing: true,
    });
  });
});
