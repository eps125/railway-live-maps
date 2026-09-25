import { describe, expect, it } from "vitest";
import { mergeExplorerBerths, windowStartDate, type BindingRow } from "./berthExplorer.js";

const binding = (overrides: Partial<BindingRow>): BindingRow => ({
  kind: "published",
  map_slug: "lancaster",
  map_name: "Lancaster",
  element_id: "e1",
  display_name: null,
  td_area: "PX",
  berth: "0001",
  combined_order: null,
  ...overrides,
});

describe("mergeExplorerBerths (Milestone 72)", () => {
  const seenAt = new Date("2026-09-25T10:00:00Z");

  it("joins activity to allocations, lists bound-but-unseen berths, and sorts by berth", () => {
    const rows = mergeExplorerBerths(
      "PX",
      [
        {
          berth: "0003",
          events_in: 2,
          events_out: 1,
          active_days: 1,
          first_seen_at: seenAt,
          last_seen_at: seenAt,
        },
        {
          berth: "0001",
          events_in: 1,
          events_out: 0,
          active_days: 1,
          first_seen_at: seenAt,
          last_seen_at: seenAt,
        },
      ],
      [
        binding({ berth: "0001" }),
        binding({ berth: "0002", element_id: "e2" }),
        binding({ kind: "draft", berth: "0001", element_id: "d9" }),
      ],
      new Map([["0002", new Date("2026-06-01T00:00:00Z")]]),
    );
    expect(rows.map((r) => r.berth)).toEqual(["0001", "0002", "0003"]);
    expect(rows[0]!.allocations.map((a) => a.kind)).toEqual(["published", "draft"]);
    expect(rows[1]).toMatchObject({
      eventsIn: 0,
      lastSeenAt: null,
      lastSeenEverAt: "2026-06-01T00:00:00.000Z",
    });
    expect(rows[2]!.allocations).toEqual([]);
  });

  it("gives every member of a combined berth, in order, across areas — but lists only this area's", () => {
    const rows = mergeExplorerBerths(
      "PX",
      [],
      [
        binding({ berth: "0020", element_id: "c", combined_order: 2 }),
        binding({ td_area: "CL", berth: "0500", element_id: "c", combined_order: 1 }),
        // The same element id on another map is a different element.
        binding({ map_slug: "other", berth: "0021", element_id: "c" }),
      ],
      new Map(),
    );
    expect(rows.map((r) => r.berth)).toEqual(["0020", "0021"]);
    expect(rows[0]!.allocations[0]!.combinedMembers).toEqual([
      { tdArea: "CL", berth: "0500" },
      { tdArea: "PX", berth: "0020" },
    ]);
    expect(rows[1]!.allocations[0]!.combinedMembers).toBeNull();
  });
});

describe("windowStartDate", () => {
  it("counts today as the first day of the window, in UTC", () => {
    expect(windowStartDate(new Date("2026-09-25T00:30:00Z"), 7)).toBe("2026-09-19");
    expect(windowStartDate(new Date("2026-09-25T23:30:00Z"), 1)).toBe("2026-09-25");
  });
});
