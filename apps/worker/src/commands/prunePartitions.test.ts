import { describe, expect, it } from "vitest";
import { partitionMonthEndsBefore } from "./prunePartitions.js";

describe("partitionMonthEndsBefore", () => {
  const cutoff = new Date("2026-09-01T00:00:00Z");

  it("prunes a partition whose whole month is before the cutoff", () => {
    expect(partitionMonthEndsBefore("raw_feed_event_2026_07", "raw_feed_event", cutoff)).toBe(true);
    expect(partitionMonthEndsBefore("raw_feed_event_2026_08", "raw_feed_event", cutoff)).toBe(true);
  });

  it("does not prune the cutoff month or later", () => {
    expect(partitionMonthEndsBefore("raw_feed_event_2026_09", "raw_feed_event", cutoff)).toBe(
      false,
    );
    expect(partitionMonthEndsBefore("raw_feed_event_2026_10", "raw_feed_event", cutoff)).toBe(
      false,
    );
  });

  it("keeps a partition whose month contains the cutoff even when the cutoff is mid-month", () => {
    const midMonth = new Date("2026-09-15T00:00:00Z");
    expect(partitionMonthEndsBefore("raw_feed_event_2026_09", "raw_feed_event", midMonth)).toBe(
      false,
    );
    expect(partitionMonthEndsBefore("raw_feed_event_2026_08", "raw_feed_event", midMonth)).toBe(
      true,
    );
  });

  it("ignores the parent (default) partition and any non-monthly name", () => {
    expect(partitionMonthEndsBefore("raw_feed_event_default", "raw_feed_event", cutoff)).toBe(
      false,
    );
    expect(partitionMonthEndsBefore("raw_feed_event", "raw_feed_event", cutoff)).toBe(false);
  });

  it("requires the partition name to match its parent", () => {
    expect(partitionMonthEndsBefore("td_s_event_2026_07", "raw_feed_event", cutoff)).toBe(false);
  });

  it("handles the December → January year rollover", () => {
    const jan = new Date("2027-01-01T00:00:00Z");
    expect(partitionMonthEndsBefore("td_s_event_2026_12", "td_s_event", jan)).toBe(true);
    expect(partitionMonthEndsBefore("td_s_event_2027_01", "td_s_event", jan)).toBe(false);
  });
});
