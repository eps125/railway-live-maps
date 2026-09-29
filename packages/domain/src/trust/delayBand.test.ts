import { describe, expect, it } from "vitest";
import { delayBandForMinutesLate, delayBandForMovement } from "./delayBand.js";

// garner flags bits 3-4: 0 = EARLY, 1 = ON TIME, 2 = LATE, 3 = OFF ROUTE (garnerMovement.ts).
const EARLY = 0 << 3;
const ON_TIME = 1 << 3;
const LATE = 2 << 3;
const OFF_ROUTE = 3 << 3;

describe("delayBandForMinutesLate", () => {
  it("uses the owner's 15 / 30 / 60 minute boundaries", () => {
    expect(delayBandForMinutesLate(null)).toBe("none");
    expect(delayBandForMinutesLate(0)).toBe("none");
    expect(delayBandForMinutesLate(14)).toBe("none");
    expect(delayBandForMinutesLate(15)).toBe("minor");
    expect(delayBandForMinutesLate(29)).toBe("minor");
    expect(delayBandForMinutesLate(30)).toBe("moderate");
    expect(delayBandForMinutesLate(59)).toBe("moderate");
    expect(delayBandForMinutesLate(60)).toBe("severe");
    expect(delayBandForMinutesLate(240)).toBe("severe");
  });

  it("never bands an early train", () => {
    expect(delayBandForMinutesLate(-45)).toBe("none");
  });
});

describe("delayBandForMovement", () => {
  it("bands a late report by its variation", () => {
    expect(delayBandForMovement(20, LATE | 1)).toBe("minor");
    expect(delayBandForMovement(45, LATE | 2)).toBe("moderate");
    expect(delayBandForMovement(75, LATE)).toBe("severe");
  });

  it("leaves early, on-time, off-route and missing reports unbanded", () => {
    // Garner stores the magnitude unsigned; direction comes only from the flags.
    expect(delayBandForMovement(70, EARLY)).toBe("none");
    expect(delayBandForMovement(0, ON_TIME)).toBe("none");
    expect(delayBandForMovement(90, OFF_ROUTE)).toBe("none");
    expect(delayBandForMovement(null, LATE)).toBe("none");
  });
});
