import { describe, expect, it } from "vitest";
import { previousCalendarDate } from "./runResolution.js";

describe("previousCalendarDate (docs/adr/0008)", () => {
  it("steps back one calendar day within a month", () => {
    expect(previousCalendarDate("2026-09-14")).toBe("2026-09-13");
  });

  it("steps back across a month boundary", () => {
    expect(previousCalendarDate("2026-09-01")).toBe("2026-08-31");
  });

  it("steps back across a year boundary", () => {
    expect(previousCalendarDate("2026-01-01")).toBe("2025-12-31");
  });

  it("steps back across the BST-to-GMT clock change without skipping or repeating a day", () => {
    // 2026-10-25 is the last Sunday in October 2026 — the UK's real BST->GMT transition. Pure
    // calendar-string arithmetic (UTC midnight in, UTC midnight out) must be unaffected by this
    // even though `londonToday`/`londonMinutesSinceMidnight` are themselves zone-aware.
    expect(previousCalendarDate("2026-10-26")).toBe("2026-10-25");
  });

  it("steps back across a leap day", () => {
    expect(previousCalendarDate("2028-03-01")).toBe("2028-02-29");
  });
});
