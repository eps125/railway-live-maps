import { describe, expect, it } from "vitest";
import { computeServiceDate } from "./serviceDate.js";

describe("computeServiceDate", () => {
  it("a normal daytime event stays on its calendar day", () => {
    expect(computeServiceDate("2026-08-10T12:00:00.000Z")).toBe("2026-08-10");
  });

  it("an event just after local midnight (before the 03:00 boundary) belongs to the previous traffic day (GMT)", () => {
    // 2026-01-10T02:30:00Z is 02:30 London local time in January (GMT, UTC+0).
    expect(computeServiceDate("2026-01-10T02:30:00.000Z")).toBe("2026-01-09");
  });

  it("an event at/after the 03:00 boundary stays on its own traffic day (GMT)", () => {
    expect(computeServiceDate("2026-01-10T03:30:00.000Z")).toBe("2026-01-10");
  });

  it("the same boundary applies correctly during BST (UTC+1)", () => {
    // 2026-07-10T01:30:00Z is 02:30 London local time in July (BST, UTC+1) — before 03:00 local.
    expect(computeServiceDate("2026-07-10T01:30:00.000Z")).toBe("2026-07-09");
    // 2026-07-10T02:30:00Z is 03:30 London local time — at/after the boundary.
    expect(computeServiceDate("2026-07-10T02:30:00.000Z")).toBe("2026-07-10");
  });

  it("correctly rolls over a month/year boundary", () => {
    expect(computeServiceDate("2027-01-01T01:00:00.000Z")).toBe("2026-12-31");
  });
});
