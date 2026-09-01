import { describe, expect, it } from "vitest";
import { GARNER_NOT_DELETED, garnerDeletedToTs } from "./bridge.js";

describe("garnerDeletedToTs", () => {
  it("maps garner's NOT_DELETED sentinel (0xffffffff) to null — a live schedule", () => {
    expect(GARNER_NOT_DELETED).toBe(0xffffffff);
    expect(garnerDeletedToTs(GARNER_NOT_DELETED)).toBeNull();
  });

  it("maps 0 to null (also treated as live)", () => {
    expect(garnerDeletedToTs(0)).toBeNull();
    expect(garnerDeletedToTs(null)).toBeNull();
    expect(garnerDeletedToTs(undefined)).toBeNull();
  });

  it("maps a real withdrawal epoch to that instant", () => {
    // 2026-08-16T00:00:00Z
    const epoch = Math.floor(Date.UTC(2026, 7, 16) / 1000);
    expect(garnerDeletedToTs(epoch)?.toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });

  it("does not treat a value just below the sentinel as live", () => {
    const justBelow = GARNER_NOT_DELETED - 1;
    expect(garnerDeletedToTs(justBelow)).not.toBeNull();
  });
});
