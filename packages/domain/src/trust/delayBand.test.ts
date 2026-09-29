import { describe, expect, it } from "vitest";
import { delayBandForMinutesLate, delayBandForMovement } from "./delayBand.js";

// garner flags bits 3-4: 0 = EARLY, 1 = ON TIME, 2 = LATE, 3 = OFF ROUTE (garnerMovement.ts).
const EARLY = 0 << 3;
const ON_TIME = 1 << 3;
const LATE = 2 << 3;
const OFF_ROUTE = 3 << 3;

describe("delayBandForMinutesLate", () => {
  it("uses the owner's 15 / 30 / 60 minute boundaries", () => {
    expect(delayBandForMinutesLate(0)).toBe("on_time");
    expect(delayBandForMinutesLate(14)).toBe("on_time");
    expect(delayBandForMinutesLate(15)).toBe("minor");
    expect(delayBandForMinutesLate(29)).toBe("minor");
    expect(delayBandForMinutesLate(30)).toBe("moderate");
    expect(delayBandForMinutesLate(59)).toBe("moderate");
    expect(delayBandForMinutesLate(60)).toBe("severe");
    expect(delayBandForMinutesLate(240)).toBe("severe");
  });

  it("counts an early train as on time, and nothing known as no information", () => {
    expect(delayBandForMinutesLate(-45)).toBe("on_time");
    expect(delayBandForMinutesLate(null)).toBe("none");
  });
});

describe("delayBandForMovement", () => {
  it("bands a late report by its variation", () => {
    expect(delayBandForMovement(20, LATE | 1)).toBe("minor");
    expect(delayBandForMovement(45, LATE | 2)).toBe("moderate");
    expect(delayBandForMovement(75, LATE)).toBe("severe");
    expect(delayBandForMovement(9, LATE)).toBe("on_time");
  });

  it("calls early and on-time reports on time (garner stores the minutes unsigned)", () => {
    expect(delayBandForMovement(70, EARLY)).toBe("on_time");
    expect(delayBandForMovement(0, ON_TIME)).toBe("on_time");
    expect(delayBandForMovement(null, ON_TIME)).toBe("on_time");
  });

  it("gives no information for off route, or a late/early report missing its minutes", () => {
    expect(delayBandForMovement(90, OFF_ROUTE)).toBe("none");
    expect(delayBandForMovement(null, LATE)).toBe("none");
    expect(delayBandForMovement(undefined, EARLY)).toBe("none");
  });
});
