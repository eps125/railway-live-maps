import { describe, expect, it } from "vitest";
import { berthInfo } from "./liveCells.js";
import { followTrain, nearbyPlaceTiplocs } from "./followTrain.js";
import type { BerthState } from "./types.js";

function berth(id: string, inhibitedBy?: string) {
  return { id, type: "berth", ...(inhibitedBy ? { inhibitedBy } : {}) };
}

function showing(entries: Record<string, string | null>): Record<string, BerthState> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, description]) => [id, { description, enteredAt: null }]),
  );
}

const info = berthInfo([berth("a"), berth("b"), berth("c"), berth("d", "c")]);

describe("followTrain (sticky run popup, 2026-10-30)", () => {
  it("stays put while the berth still shows the headcode", () => {
    const result = followTrain(
      { elementId: "a", headcode: "1A23" },
      showing({ a: "1A23", b: "1A23" }),
      info,
    );
    expect(result).toEqual({ elementId: "a", lost: null });
  });

  it("moves to the one berth now showing the headcode", () => {
    const result = followTrain(
      { elementId: "a", headcode: "1A23" },
      showing({ a: null, b: "1A23" }),
      info,
    );
    expect(result).toEqual({ elementId: "b", lost: null });
  });

  it("does not follow a different train that entered the old berth", () => {
    const result = followTrain({ elementId: "a", headcode: "1A23" }, showing({ a: "2B45" }), info);
    expect(result).toEqual({ elementId: "a", lost: "gone" });
  });

  it("never guesses between two berths showing the headcode (rule 5)", () => {
    const result = followTrain(
      { elementId: "a", headcode: "1A23" },
      showing({ a: null, b: "1A23", c: "1A23" }),
      info,
    );
    expect(result).toEqual({ elementId: "a", lost: "ambiguous" });
  });

  it("does not count an inhibited fringe twin as a second sighting", () => {
    const result = followTrain(
      { elementId: "a", headcode: "1A23" },
      showing({ a: null, c: "1A23", d: "1A23" }),
      info,
    );
    expect(result).toEqual({ elementId: "c", lost: null });
  });
});

describe("nearbyPlaceTiplocs (popup position, 2026-10-30)", () => {
  it("lists stations and labels with a TIPLOC near the point, nearest first", () => {
    const elements = [
      { type: "station", x: 300, y: 0, tiploc: "FAR" },
      { type: "label", x: 50, y: 0, tiploc: "JUNC" },
      { type: "label", x: 10, y: 0 },
      { type: "berth", x: 0, y: 0, tiploc: "NOPE" },
      { type: "station", x: 900, y: 0, tiploc: "TOOFAR" },
    ];
    expect(nearbyPlaceTiplocs({ x: 0, y: 0 }, elements)).toEqual(["JUNC", "FAR"]);
  });
});
