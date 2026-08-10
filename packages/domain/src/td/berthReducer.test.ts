import { describe, expect, it } from "vitest";
import { applyCA, applyCB, applyCC, type OpenOccupancySnapshot } from "./berthReducer.js";

function open(description: string, occupancyId = "occ-1"): OpenOccupancySnapshot {
  return { occupancyId, description, enteredAt: "2026-08-04T12:00:00.000Z" };
}

describe("applyCA", () => {
  it("normal step: closes from, opens to, no anomaly", () => {
    const result = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "2A16",
      fromOpen: open("2A16"),
      toOpen: null,
    });

    expect(result.effects).toEqual([
      { kind: "closeOccupancy", berth: "from", occupancyId: "occ-1", exitReason: "stepped_out" },
      { kind: "openOccupancy", berth: "to", description: "2A16", entryReason: "ca_step" },
    ]);
  });

  it("destination overwrite: closes the existing to-occupancy with overwritten_by_step, no anomaly", () => {
    const result = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "2A16",
      fromOpen: open("2A16", "occ-from"),
      toOpen: open("9Z99", "occ-to"),
    });

    expect(result.effects).toEqual([
      {
        kind: "closeOccupancy",
        berth: "from",
        occupancyId: "occ-from",
        exitReason: "stepped_out",
      },
      {
        kind: "closeOccupancy",
        berth: "to",
        occupancyId: "occ-to",
        exitReason: "overwritten_by_step",
      },
      { kind: "openOccupancy", berth: "to", description: "2A16", entryReason: "ca_step" },
    ]);
  });

  it("empty source: records a from_berth_empty anomaly but still opens to", () => {
    const result = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "2A16",
      fromOpen: null,
      toOpen: null,
    });

    expect(result.effects).toEqual([
      {
        kind: "recordAnomaly",
        anomalyCode: "from_berth_empty",
        berth: "from",
        details: { messageType: "CA", fromBerth: "0123", expectedDescription: "2A16" },
      },
      { kind: "openOccupancy", berth: "to", description: "2A16", entryReason: "ca_step" },
    ]);
  });

  it("mismatched source description: records a mismatch anomaly and still closes/opens", () => {
    const result = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "2A16",
      fromOpen: open("9Z99", "occ-from"),
      toOpen: null,
    });

    expect(result.effects[0]).toEqual({
      kind: "recordAnomaly",
      anomalyCode: "from_berth_description_mismatch",
      berth: "from",
      details: {
        messageType: "CA",
        fromBerth: "0123",
        expectedDescription: "2A16",
        actualDescription: "9Z99",
      },
    });
    expect(result.effects).toContainEqual({
      kind: "closeOccupancy",
      berth: "from",
      occupancyId: "occ-from",
      exitReason: "stepped_out",
    });
  });

  it('"----" (signaller manual clear, not a real headcode): closes from/to but never opens a new occupancy carrying it', () => {
    const result = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "----",
      fromOpen: open("2A16", "occ-from"),
      toOpen: open("9Z99", "occ-to"),
    });

    expect(result.effects).toEqual([
      { kind: "closeOccupancy", berth: "from", occupancyId: "occ-from", exitReason: "stepped_out" },
      {
        kind: "closeOccupancy",
        berth: "to",
        occupancyId: "occ-to",
        exitReason: "overwritten_by_step",
      },
    ]);
  });

  it('"----" with an empty/mismatched from: no mismatch anomaly (a placeholder can never meaningfully mismatch a real headcode)', () => {
    const emptyFrom = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "----",
      fromOpen: null,
      toOpen: null,
    });
    expect(emptyFrom.effects).toEqual([]);

    const mismatchedFrom = applyCA({
      fromBerth: "0123",
      toBerth: "0124",
      description: "----",
      fromOpen: open("2A16", "occ-from"),
      toOpen: null,
    });
    expect(mismatchedFrom.effects).toEqual([
      { kind: "closeOccupancy", berth: "from", occupancyId: "occ-from", exitReason: "stepped_out" },
    ]);
  });
});

describe("applyCB", () => {
  it("cancel: closes from, no to effects", () => {
    const result = applyCB({ fromBerth: "0124", description: "2A16", fromOpen: open("2A16") });

    expect(result.effects).toEqual([
      { kind: "closeOccupancy", berth: "from", occupancyId: "occ-1", exitReason: "cancelled" },
    ]);
  });

  it("empty source: records an anomaly, nothing to close", () => {
    const result = applyCB({ fromBerth: "0124", description: "2A16", fromOpen: null });

    expect(result.effects).toEqual([
      {
        kind: "recordAnomaly",
        anomalyCode: "from_berth_empty",
        berth: "from",
        details: { messageType: "CB", fromBerth: "0124", expectedDescription: "2A16" },
      },
    ]);
  });

  it('"----" (signaller manual clear): still closes a real open occupancy, no mismatch anomaly', () => {
    const result = applyCB({
      fromBerth: "0124",
      description: "----",
      fromOpen: open("2A16", "occ-1"),
    });

    expect(result.effects).toEqual([
      { kind: "closeOccupancy", berth: "from", occupancyId: "occ-1", exitReason: "cancelled" },
    ]);
  });

  it('"----" with nothing open: no anomaly, no effects at all', () => {
    const result = applyCB({ fromBerth: "0124", description: "----", fromOpen: null });
    expect(result.effects).toEqual([]);
  });
});

describe("applyCC", () => {
  it("interpose into an empty berth: just opens", () => {
    const result = applyCC({ toBerth: "0125", description: "2A17", toOpen: null });

    expect(result.effects).toEqual([
      { kind: "openOccupancy", berth: "to", description: "2A17", entryReason: "cc_interpose" },
    ]);
  });

  it("interpose overwrite: closes the existing occupancy with overwritten_by_interpose, no anomaly", () => {
    const result = applyCC({ toBerth: "0125", description: "2A17", toOpen: open("9Z99", "occ-x") });

    expect(result.effects).toEqual([
      {
        kind: "closeOccupancy",
        berth: "to",
        occupancyId: "occ-x",
        exitReason: "overwritten_by_interpose",
      },
      { kind: "openOccupancy", berth: "to", description: "2A17", entryReason: "cc_interpose" },
    ]);
  });

  it('"----" (signaller manual clear) into an empty berth: no effects at all — nothing to close, and never opens a fake occupancy', () => {
    const result = applyCC({ toBerth: "0125", description: "----", toOpen: null });
    expect(result.effects).toEqual([]);
  });

  it('"----" over a real occupant: closes it, but does not open a new "----" occupancy in its place', () => {
    const result = applyCC({ toBerth: "0125", description: "----", toOpen: open("9Z99", "occ-x") });

    expect(result.effects).toEqual([
      {
        kind: "closeOccupancy",
        berth: "to",
        occupancyId: "occ-x",
        exitReason: "overwritten_by_interpose",
      },
    ]);
  });
});
