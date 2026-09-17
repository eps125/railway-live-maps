import { describe, expect, it } from "vitest";
import { headcodeFromTrustId } from "./trustId.js";

describe("headcodeFromTrustId", () => {
  it("extracts the headcode from a real Change of Identity pair (2026-09-17 incident)", () => {
    expect(headcodeFromTrustId("426C02C417")).toBe("6C02");
    expect(headcodeFromTrustId("420C02C417")).toBe("0C02");
  });

  it("returns null for anything that isn't exactly 10 characters, rather than guessing", () => {
    expect(headcodeFromTrustId("")).toBeNull();
    expect(headcodeFromTrustId("729S93MT1")).toBeNull();
    expect(headcodeFromTrustId("729S93MT100")).toBeNull();
  });
});
