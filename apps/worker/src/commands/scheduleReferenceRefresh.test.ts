import { describe, expect, it } from "vitest";
import { msUntilNextLondonTime } from "./scheduleReferenceRefresh.js";

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

describe("msUntilNextLondonTime", () => {
  it("counts down to later today (BST, UTC+1) when the target hasn't passed yet", () => {
    // 2026-08-12T23:30:00Z = 00:30 BST on 2026-08-13; target 01:00 BST is 30 min away.
    const now = new Date("2026-08-12T23:30:00Z");
    expect(msUntilNextLondonTime(now, 1, 0)).toBe(30 * MIN_MS);
  });

  it("rolls over to tomorrow (BST) once today's target has already passed", () => {
    // 2026-08-12T22:00:00Z = 23:00 BST on 2026-08-12; next 01:00 BST is 02:00 the next day.
    const now = new Date("2026-08-12T22:00:00Z");
    expect(msUntilNextLondonTime(now, 1, 0)).toBe(2 * HOUR_MS);
  });

  it("rolls over to tomorrow when now is exactly the target time", () => {
    // 2026-08-13T00:00:00Z = 01:00 BST exactly — must not fire again immediately.
    const now = new Date("2026-08-13T00:00:00Z");
    expect(msUntilNextLondonTime(now, 1, 0)).toBe(24 * HOUR_MS);
  });

  it("counts down correctly in winter (GMT, UTC+0)", () => {
    // 2026-01-12T22:00:00Z = 22:00 GMT (no DST offset); next 01:00 GMT is 3 hours away.
    const now = new Date("2026-01-12T22:00:00Z");
    expect(msUntilNextLondonTime(now, 1, 0)).toBe(3 * HOUR_MS);
  });
});
