import { describe, expect, it } from "vitest";
import { decodeTrustMovementFlags, signedVariationMinutes } from "./garnerMovement.js";

describe("decodeTrustMovementFlags", () => {
  it("decodes a plain automatic on-time departure (flags = 0x01 | 0x08)", () => {
    expect(decodeTrustMovementFlags(0x01 | 0x08)).toEqual({
      eventKind: "departure",
      manual: false,
      variation: "on_time",
      offRoute: false,
      terminated: false,
      correction: false,
    });
  });

  it("decodes a late arrival at destination that terminated the train (0x03 | 0x10 | 0x40)", () => {
    expect(decodeTrustMovementFlags(0x03 | 0x10 | 0x40)).toEqual({
      eventKind: "arrival_destination",
      manual: false,
      variation: "late",
      offRoute: false,
      terminated: true,
      correction: false,
    });
  });

  it("decodes an early manual arrival (0x02 | 0x00 variation | 0x04)", () => {
    const decoded = decodeTrustMovementFlags(0x02 | 0x04);
    expect(decoded.eventKind).toBe("arrival");
    expect(decoded.manual).toBe(true);
    expect(decoded.variation).toBe("early");
  });

  it("decodes an off-route correction report (0x18 | 0x20 | 0x80)", () => {
    const decoded = decodeTrustMovementFlags(0x18 | 0x20 | 0x80);
    expect(decoded.variation).toBe("off_route");
    expect(decoded.offRoute).toBe(true);
    expect(decoded.correction).toBe(true);
  });

  it("treats null/undefined/garbage flags as all-zero (early automatic, unknown event)", () => {
    for (const bad of [null, undefined, Number.NaN]) {
      expect(decodeTrustMovementFlags(bad)).toEqual({
        eventKind: "unknown",
        manual: false,
        variation: "early",
        offRoute: false,
        terminated: false,
        correction: false,
      });
    }
  });
});

describe("signedVariationMinutes", () => {
  it("returns a positive value for late, negative for early, 0 for on time", () => {
    expect(signedVariationMinutes(4, "late")).toBe(4);
    expect(signedVariationMinutes(4, "early")).toBe(-4);
    expect(signedVariationMinutes(4, "on_time")).toBe(0);
  });

  it("returns null for off route (lateness is meaningless there)", () => {
    expect(signedVariationMinutes(4, "off_route")).toBeNull();
  });

  it("uses the magnitude of the stored value even if it is already signed", () => {
    expect(signedVariationMinutes(-6, "late")).toBe(6);
  });

  it("treats missing timetable_variation as 0", () => {
    expect(signedVariationMinutes(null, "late")).toBe(0);
    expect(signedVariationMinutes(undefined, "early")).toBe(-0);
  });
});
