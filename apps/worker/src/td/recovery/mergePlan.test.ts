import { describe, expect, it } from "vitest";
import { planBerthMerge, planByteMerge, type MergeBerthEvent } from "./mergePlan.js";
import type { BerthEventRef } from "./repairPlan.js";

const at = (hms: string) => new Date(`2026-10-31T${hms}Z`);

function ev(
  id: string,
  hms: string,
  type: "CA" | "CB" | "CC",
  description: string,
  role: "from" | "to",
  recovered = false,
): MergeBerthEvent {
  return {
    rawEventId: id,
    rawEventNormalizedAt: at(hms),
    eventAt: at(hms),
    ingestionSequence: recovered ? `rec:${id}` : id,
    type,
    description,
    role,
    recovered,
  };
}

const post = (e: MergeBerthEvent): BerthEventRef => {
  const { recovered, ...ref } = e;
  void recovered;
  return ref;
};

describe("planBerthMerge (31 Oct merge-mode recovery)", () => {
  it("PX 0286: the recovered CB ends 0646 at 06:51:55, not when 1Z86 arrived at 09:14", () => {
    const firstPost = post(ev("900", "09:14:03", "CA", "1Z86", "to"));
    const plan = planBerthMerge({
      tdArea: "PX",
      berth: "0286",
      pre: {
        occupancyId: "occ-0646",
        entryEventId: null,
        description: "0646",
        enteredAt: at("05:28:36"),
        leftAt: at("09:14:03"),
        exitEventId: "900",
      },
      events: [ev("rec:1", "06:51:55", "CB", "0646", "from", true)],
      firstPost,
      existing: [],
    });

    // RLM's own events alone reproduce today's row: 0646 overwritten by 1Z86 at 09:14.
    expect(plan.check).toEqual({ rows: 1, reproduced: 1 });
    expect(plan.updates).toEqual([
      {
        occupancyId: "occ-0646",
        close: {
          leftAt: at("06:51:55"),
          exitEventId: "rec:1",
          exitEventNormalizedAt: at("06:51:55"),
          exitReason: "cancelled",
        },
      },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.missingRows).toBe(0);
    // 1Z86 now steps into an empty berth: nothing to overwrite, no anomaly.
    expect(plan.anomalies).toEqual([]);
    expect(plan.replaceAnomaliesOf).toEqual([{ rawEventId: "900", eventAt: at("09:14:03") }]);
    expect(plan.currentState).toBeNull();
  });

  it("interleaved: a recovered step out closes a held row early; the next held step is clean", () => {
    // Held: 1A01 steps in (row R1) at 06:44:00, 2B02 steps in at 06:46:00 (row R2).
    // Lost: 1A01 stepped out at 06:45:00. Without it R1 was overwritten by 2B02.
    const plan = planBerthMerge({
      tdArea: "WA",
      berth: "B016",
      pre: null,
      events: [
        ev("10", "06:44:00", "CA", "1A01", "to"),
        ev("rec:2", "06:45:00", "CA", "1A01", "from", true),
        ev("11", "06:46:00", "CA", "2B02", "to"),
      ],
      firstPost: null,
      existing: [
        {
          occupancyId: "R1",
          entryEventId: "10",
          description: "1A01",
          enteredAt: at("06:44:00"),
          leftAt: at("06:46:00"),
          exitEventId: "11",
        },
        {
          occupancyId: "R2",
          entryEventId: "11",
          description: "2B02",
          enteredAt: at("06:46:00"),
          leftAt: null,
          exitEventId: null,
        },
      ],
    });
    expect(plan.check).toEqual({ rows: 2, reproduced: 2 });
    expect(plan.updates).toEqual([
      {
        occupancyId: "R1",
        close: {
          leftAt: at("06:45:00"),
          exitEventId: "rec:2",
          exitEventNormalizedAt: at("06:45:00"),
          exitReason: "stepped_out",
        },
      },
    ]);
    expect(plan.inserts).toEqual([]);
    // Idle since: the current state is 2B02's, from the last event.
    expect(plan.currentState).toEqual({
      description: "2B02",
      enteredAt: at("06:46:00"),
      source: expect.objectContaining({ rawEventId: "11" }),
    });
  });

  it("inserts the rows recovered steps open, closed by the held events that follow", () => {
    const plan = planBerthMerge({
      tdArea: "PX",
      berth: "0300",
      pre: null,
      events: [
        ev("rec:5", "06:47:00", "CA", "1P10", "to", true),
        ev("20", "06:48:00", "CA", "1P10", "from"),
      ],
      firstPost: null,
      existing: [],
    });
    expect(plan.inserts).toEqual([
      expect.objectContaining({
        description: "1P10",
        entryEventId: "rec:5",
        entryReason: "ca_step",
        close: expect.objectContaining({ exitEventId: "20", exitReason: "stepped_out" }),
      }),
    ]);
    // Today 1P10 stepped out of an empty berth: that anomaly goes, none replaces it.
    expect(plan.anomalies).toEqual([]);
    expect(plan.replaceAnomaliesOf.map((e) => e.rawEventId)).toEqual(["20"]);
  });

  it("reports a database that its own events don't reproduce, and rows it can't find", () => {
    const plan = planBerthMerge({
      tdArea: "PX",
      berth: "0286",
      pre: null,
      events: [ev("30", "06:50:00", "CA", "1Z00", "to")],
      firstPost: null,
      existing: [
        {
          occupancyId: "R9",
          entryEventId: "30",
          description: "1Z00",
          enteredAt: at("06:50:00"),
          leftAt: at("06:55:00"), // the replay says it is still open
          exitEventId: "31",
        },
      ],
    });
    expect(plan.check).toEqual({ rows: 1, reproduced: 0 });

    const missing = planBerthMerge({
      tdArea: "PX",
      berth: "0286",
      pre: null,
      events: [ev("40", "06:50:00", "CA", "1Z00", "to")],
      firstPost: null,
      existing: [],
    });
    expect(missing.missingRows).toBe(1);
  });
});

describe("planByteMerge", () => {
  const sev = (id: string, hms: string, value: number, recovered = false) => ({
    rawEventId: id,
    rawEventNormalizedAt: at(hms),
    eventAt: at(hms),
    ingestionSequence: id,
    value,
    sourceKind: "update" as const,
    recovered,
  });

  it("replays held and recovered statements together, and checks the held ones alone", () => {
    const plan = planByteMerge({
      tdArea: "PX",
      address: "0B",
      preBits: Array(8).fill(false),
      pre: null,
      events: [sev("1", "06:44:00", 0x01), sev("rec:2", "06:45:00", 0x03, true)],
      firstPost: { ...sev("3", "07:30:00", 0x03), sourceKind: "refresh" },
      existingTransitions: 2,
    });
    // Own: bit 0 at 06:44, bit 1 only at the 07:30 refresh. Merged: bit 1 at 06:45 instead.
    expect(plan.check).toEqual({ existing: 2, reproduced: 2 });
    expect(plan.transitions.map((t) => [t.bitIndex, t.event.rawEventId])).toEqual([
      [0, "1"],
      [1, "rec:2"],
    ]);
    expect(plan.replaceTransitionsOf).toEqual([
      { rawEventId: "1", eventAt: at("06:44:00") },
      { rawEventId: "3", eventAt: at("07:30:00") },
    ]);
    expect(plan.currentState).toBeNull();
  });

  it("skips a refresh chunk older than an SF in its sweep, as the projector does", () => {
    // SF 01 at 06:44:20 (inside a sweep that began 06:44:18); the sweep's chunk for the byte
    // still says 00 at 06:44:25. The projector keeps 01; so must the replay.
    const plan = planByteMerge({
      tdArea: "Q1",
      address: "58",
      preBits: Array(8).fill(false),
      pre: { value: 0x00, sourceKind: "refresh", statedAt: at("06:30:00") },
      events: [
        sev("rec:7", "06:44:20", 0x01, true),
        { ...sev("8", "06:44:25", 0x00), sourceKind: "refresh", sweepStartedAt: at("06:44:18") },
      ],
      firstPost: null,
      existingTransitions: 0,
    });
    expect(plan.transitions.map((t) => [t.bitIndex, t.newValue, t.event.rawEventId])).toEqual([
      [0, true, "rec:7"],
    ]);
    expect(plan.currentState).toMatchObject({ value: 0x01, source: { rawEventId: "rec:7" } });
  });
});
