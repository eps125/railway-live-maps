import { describe, expect, it } from "vitest";
import {
  planBerthRepair,
  planSByteRepair,
  type BerthEventRef,
  type SByteEventRef,
} from "./repairPlan.js";

const t = (s: string): Date => new Date(`2026-10-15T23:${s}Z`);
let n = 0;
function ev(
  type: "CA" | "CB" | "CC",
  role: "from" | "to",
  description: string,
  at: string,
  id = String(++n),
): BerthEventRef {
  return {
    rawEventId: id,
    rawEventNormalizedAt: t(at),
    eventAt: t(at),
    ingestionSequence: id,
    type,
    description,
    role,
  };
}

describe("planBerthRepair", () => {
  it("a train that entered during the gap and left after: inserts its occupancy, removes the bogus from_berth_empty", () => {
    const plan = planBerthRepair({
      tdArea: "PX",
      berth: "0253",
      pre: null,
      recovered: [ev("CA", "to", "4C31", "55:50", "r1")],
      firstPost: ev("CA", "from", "4C31", "57:02", "p1"),
    });
    expect(plan.preClose).toBeNull();
    expect(plan.inserts).toEqual([
      {
        description: "4C31",
        enteredAt: t("55:50"),
        entryEventId: "r1",
        entryEventNormalizedAt: t("55:50"),
        entryReason: "ca_step",
        close: {
          leftAt: t("57:02"),
          exitEventId: "p1",
          exitEventNormalizedAt: t("57:02"),
          exitReason: "stepped_out",
        },
      },
    ]);
    // The original fold logged from_berth_empty for p1; the corrected one logs nothing.
    expect(plan.anomalies).toEqual([]);
    expect(plan.replaceAnomaliesOfEventId).toBe("p1");
    expect(plan.currentState).toBeNull();
  });

  it("a train that left during the gap: the pre-gap occupancy now ends at the recovered step", () => {
    const plan = planBerthRepair({
      tdArea: "PX",
      berth: "0251",
      pre: { occupancyId: "77", description: "4C31", enteredAt: t("54:10") },
      recovered: [ev("CA", "from", "4C31", "55:50", "r1")],
      firstPost: ev("CA", "to", "1A11", "58:00", "p1"),
    });
    expect(plan.preClose).toEqual({
      leftAt: t("55:50"),
      exitEventId: "r1",
      exitEventNormalizedAt: t("55:50"),
      exitReason: "stepped_out",
    });
    expect(plan.inserts).toEqual([]); // the first post-gap open already exists in the database
    expect(plan.anomalies).toEqual([]);
  });

  it("an untouched pre-gap row stays exactly as the original fold closed it", () => {
    const plan = planBerthRepair({
      tdArea: "PX",
      berth: "0251",
      pre: { occupancyId: "77", description: "4C31", enteredAt: t("54:10") },
      recovered: [],
      firstPost: ev("CA", "from", "4C31", "57:00", "p1"),
    });
    expect(plan.preClose).toBeNull();
    expect(plan.inserts).toEqual([]);
    expect(plan.anomalies).toEqual([]);
  });

  it("records the same mismatch anomaly the projector would, with the real berth", () => {
    const plan = planBerthRepair({
      tdArea: "PX",
      berth: "0251",
      pre: { occupancyId: "77", description: "4C31", enteredAt: t("54:10") },
      recovered: [ev("CA", "from", "9Z99", "55:50", "r1")],
      firstPost: null,
    });
    expect(plan.anomalies).toEqual([
      {
        rawEventId: "r1",
        rawEventNormalizedAt: t("55:50"),
        eventAt: t("55:50"),
        ingestionSequence: "r1",
        anomalyCode: "from_berth_description_mismatch",
        details: {
          messageType: "CA",
          fromBerth: "0251",
          expectedDescription: "9Z99",
          actualDescription: "4C31",
        },
      },
    ]);
    expect(plan.preClose?.exitReason).toBe("stepped_out");
  });

  it("a berth idle since the gap gets its corrected current state", () => {
    const plan = planBerthRepair({
      tdArea: "WE",
      berth: "WUSY",
      pre: null,
      recovered: [ev("CC", "to", "0M00", "55:49", "r1")],
      firstPost: null,
    });
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.close).toBeNull();
    expect(plan.currentState).toMatchObject({ description: "0M00", enteredAt: t("55:49") });
    expect(plan.currentState?.source.rawEventId).toBe("r1");
  });

  it("chains several recovered steps on one berth and closes the last at the first post-gap event", () => {
    const plan = planBerthRepair({
      tdArea: "CV",
      berth: "9128",
      pre: { occupancyId: "5", description: "1A00", enteredAt: t("50:00") },
      recovered: [
        ev("CA", "from", "1A00", "55:50", "r1"),
        ev("CA", "to", "5U72", "55:55", "r2"),
        ev("CB", "from", "5U72", "56:01", "r3"),
        ev("CC", "to", "2B22", "56:05", "r4"),
      ],
      firstPost: ev("CA", "to", "3C33", "57:30", "p1"),
    });
    expect(plan.preClose?.exitEventId).toBe("r1");
    expect(
      plan.inserts.map((i) => [i.description, i.close?.exitEventId, i.close?.exitReason]),
    ).toEqual([
      ["5U72", "r3", "cancelled"],
      ["2B22", "p1", "overwritten_by_step"],
    ]);
  });
});

describe("planSByteRepair", () => {
  const s = (value: number, at: string, id: string): SByteEventRef => ({
    rawEventId: id,
    rawEventNormalizedAt: t(at),
    eventAt: t(at),
    ingestionSequence: id,
    value,
    sourceKind: "update",
  });

  it("recovered changes become transitions, and the first post-gap event is re-diffed against them", () => {
    const plan = planSByteRepair({
      tdArea: "Q4",
      address: "08",
      preBits: [false, false, false, false, false, false, false, false],
      recovered: [s(0x08, "55:49", "r1")],
      firstPost: s(0x0c, "57:00", "p1"),
    });
    expect(
      plan.transitions.map((x) => [x.event.rawEventId, x.bitIndex, x.previousValue, x.newValue]),
    ).toEqual([
      ["r1", 3, false, true],
      ["p1", 2, false, true], // bit 3 no longer "changes" at p1: it already changed at r1
    ]);
    expect(plan.replaceTransitionsOfEventId).toBe("p1");
    expect(plan.currentState).toBeNull();
  });

  it("an unknown pre-gap byte yields first-observation transitions, and an idle byte gets current state", () => {
    const plan = planSByteRepair({
      tdArea: "R4",
      address: "04",
      preBits: [null, null, null, null, null, null, null, null],
      recovered: [s(0xf7, "55:55", "r1")],
      firstPost: null,
    });
    expect(plan.transitions).toHaveLength(8);
    expect(plan.transitions.every((x) => x.previousValue === null)).toBe(true);
    expect(plan.currentState).toMatchObject({ value: 0xf7 });
  });
});
