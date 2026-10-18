import { describe, expect, it, vi } from "vitest";
import type { MapElement } from "@railway/map-schema";
import {
  LiveCells,
  berthCell,
  berthInfo,
  bandCell,
  routeCell,
  signalCell,
  syncCells,
  trtsCell,
  type LiveRecords,
} from "./liveCells.js";
import { changesSince, patchInPlace, recordVersion } from "./recordChanges.js";

const berth = (id: string, inhibitedBy?: string): MapElement => ({
  id,
  type: "berth",
  layerId: "l",
  zIndex: 0,
  x: 0,
  y: 0,
  width: 40,
  height: 20,
  textAlign: "center",
  fontSize: 12,
  displayName: id,
  ...(inhibitedBy ? { inhibitedBy } : {}),
});

function records(overrides: Partial<LiveRecords> = {}): LiveRecords {
  return {
    berths: {},
    signals: {},
    crossings: {},
    routes: {},
    trts: {},
    delayBands: {},
    ...overrides,
  };
}

describe("LiveCells (Milestone 94)", () => {
  it("notifies only a changed cell's subscribers, and not for an unchanged value", () => {
    const cells = new LiveCells();
    const a = vi.fn();
    const b = vi.fn();
    cells.subscribe("a", a);
    const stopB = cells.subscribe("b", b);
    cells.set("a", 1);
    cells.set("a", 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    stopB();
    cells.set("b", 2);
    expect(b).not.toHaveBeenCalled();
    expect(cells.get("b")).toBe(2);
  });
});

describe("syncCells", () => {
  const info = berthInfo([berth("b1"), berth("b2", "b1"), berth("b3")]);

  it("fills every berth's cell at first, blank where nothing is recorded", () => {
    const cells = new LiveCells();
    syncCells(
      cells,
      info,
      null,
      records({ berths: { b1: { description: "1A01", enteredAt: null } } }),
    );
    expect(cells.get(berthCell("b1"))).toBe("1A01");
    expect(cells.get(berthCell("b3"))).toBeUndefined();
  });

  it("blanks an inhibited berth showing its inhibitor's description, and follows the inhibitor", () => {
    const cells = new LiveCells();
    const first = records({
      berths: {
        b1: { description: "1A01", enteredAt: null },
        b2: { description: "1A01", enteredAt: null },
      },
    });
    const synced = syncCells(cells, info, null, first);
    expect(cells.get(berthCell("b2"))).toBeUndefined();
    // Only the inhibitor changes: the inhibited berth's display follows.
    syncCells(
      cells,
      info,
      synced,
      records({ berths: { ...first.berths, b1: { description: null, enteredAt: null } } }),
    );
    expect(cells.get(berthCell("b2"))).toBe("1A01");
  });

  it("touches only patched entries of a record patched in place", () => {
    const cells = new LiveCells();
    const live = records({
      berths: { b1: { description: "1A01", enteredAt: null } },
      signals: { s1: { state: "on" } },
      trts: {},
      routes: {},
      delayBands: { b1: "minor" },
    });
    let synced = syncCells(cells, info, null, live);
    const set = vi.spyOn(cells, "set");
    patchInPlace(live.signals, { s1: { state: "off" } });
    patchInPlace(live.trts, { s1: { state: "lit" } });
    synced = syncCells(cells, info, synced, { ...live });
    expect(cells.get(signalCell("s1"))).toBe("off");
    expect(cells.get(trtsCell("s1"))).toBe(true);
    expect(set.mock.calls.map(([key]) => key).sort()).toEqual([signalCell("s1"), trtsCell("s1")]);
    expect(cells.get(bandCell("b1"))).toBe("minor");

    // Nothing patched since: nothing touched.
    set.mockClear();
    syncCells(cells, info, synced, { ...live });
    expect(set).not.toHaveBeenCalled();
  });

  it("compares a replaced record entry by entry, including removed entries", () => {
    const cells = new LiveCells();
    const synced = syncCells(cells, info, null, records({ routes: { r1: { state: "set" } } }));
    expect(cells.get(routeCell("r1"))).toBe(true);
    syncCells(cells, info, synced, records({ routes: {} }));
    expect(cells.get(routeCell("r1"))).toBeUndefined();
  });
});

describe("recordChanges", () => {
  it("logs each in-place patch and answers what changed since a version", () => {
    const record: Record<string, number> = { a: 1 };
    expect(recordVersion(record)).toBe(0);
    expect(changesSince(record, 0)).toEqual([]);
    patchInPlace(record, { a: 2 });
    patchInPlace(record, { b: 3 });
    expect(record).toEqual({ a: 2, b: 3 });
    expect(recordVersion(record)).toBe(2);
    expect(changesSince(record, 0)).toEqual(["a", "b"]);
    expect(changesSince(record, 1)).toEqual(["b"]);
    expect(changesSince(record, 2)).toEqual([]);
  });

  it("says it no longer knows once a reader has fallen too far behind", () => {
    const record: Record<string, number> = {};
    for (let i = 0; i < 300; i += 1) patchInPlace(record, { [`k${i}`]: i });
    expect(changesSince(record, 0)).toBeNull();
    expect(changesSince(record, 299)).toEqual(["k299"]);
  });
});
