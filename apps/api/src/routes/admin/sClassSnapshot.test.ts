import { describe, expect, it } from "vitest";
import { applySnapshotOverlay } from "./sClass.js";

/** Milestone 65: a live snapshot folds in the raw S-Class rows the history projector hasn't
 * reached yet, so the mini explorer is as current as the live map. */
describe("applySnapshotOverlay", () => {
  const at = (s: number): Date => new Date(Date.UTC(2026, 8, 22, 12, 0, s));
  const sf = (address: string, data: string, s: number, tdArea = "M9") => ({
    tdArea,
    eventType: "SF_MSG",
    address,
    data,
    eventAt: at(s),
  });

  it("updates the bytes and reports each bit that changed, newest first", () => {
    const bytes = new Map<string, number | null>([["0C", 0x00]]);
    const changes = applySnapshotOverlay("M9", bytes, [sf("0C", "10", 1), sf("0C", "14", 2)]);
    expect(bytes.get("0C")).toBe(0x14);
    expect(changes).toEqual([
      { address: "0C", bit: 2, previousValue: false, newValue: true, eventAt: at(2).toISOString() },
      { address: "0C", bit: 4, previousValue: false, newValue: true, eventAt: at(1).toISOString() },
    ]);
  });

  it("reads a 4-byte refresh, and counts a refresh that disagrees as a change", () => {
    const bytes = new Map<string, number | null>([
      ["04", 0x01],
      ["05", 0x00],
    ]);
    const changes = applySnapshotOverlay("M9", bytes, [
      { tdArea: "M9", eventType: "SH_MSG", address: "04", data: "01800000", eventAt: at(3) },
    ]);
    expect([bytes.get("04"), bytes.get("05"), bytes.get("06"), bytes.get("07")]).toEqual([
      0x01, 0x80, 0x00, 0x00,
    ]);
    expect(changes).toEqual([
      { address: "05", bit: 7, previousValue: false, newValue: true, eventAt: at(3).toISOString() },
    ]);
  });

  it("makes an unknown byte known without inventing a change, and skips other areas and bad rows", () => {
    const bytes = new Map<string, number | null>([["03", null]]);
    const changes = applySnapshotOverlay("M9", bytes, [
      sf("03", "04", 1),
      sf("03", "FF", 2, "PX"),
      sf("03", "zz", 3),
    ]);
    expect(bytes.get("03")).toBe(0x04);
    expect(changes).toEqual([]);
  });
});
