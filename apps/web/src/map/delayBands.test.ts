import { describe, expect, it } from "vitest";
import { matchDelayBands, type BerthDelay } from "./delayBands.js";
import type { BerthState } from "./types.js";
import { applyDelayUpdate } from "./useLiveMapSocket.js";

const occupied = (description: string): BerthState => ({ description, enteredAt: null });
const empty: BerthState = { description: null, enteredAt: null };
const delay = (elementId: string, description: string, band: BerthDelay["band"]): BerthDelay => ({
  runKey: `run-${elementId}`,
  elementId,
  description,
  band,
  matchConfidence: "solid",
});

describe("matchDelayBands (Milestone 82)", () => {
  it("bands a berth still showing the description the band was given for", () => {
    expect(
      matchDelayBands([delay("a", "1A01", "moderate")], {
        a: occupied("1A01"),
        b: occupied("2B02"),
      }),
    ).toEqual({ a: "moderate" });
  });

  it("follows a train that stepped on since the answer, when its headcode is unique on the map", () => {
    expect(
      matchDelayBands([delay("a", "1A01", "severe")], { a: empty, b: occupied("1A01") }),
    ).toEqual({ b: "severe" });
  });

  it("carries nothing when the headcode is on more than one berth", () => {
    expect(
      matchDelayBands([delay("a", "1A01", "severe")], {
        a: empty,
        b: occupied("1A01"),
        c: occupied("1A01"),
      }),
    ).toEqual({});
  });

  it("does not colour a berth that now shows a different train", () => {
    expect(matchDelayBands([delay("a", "1A01", "minor")], { a: occupied("5Z99") })).toEqual({});
  });

  it("returns nothing when there are no bands", () => {
    expect(matchDelayBands([], { a: occupied("1A01") })).toEqual({});
  });
});

describe("applyDelayUpdate (Milestone 82)", () => {
  it("replaces a run's entry wherever the train now is, and `none` removes it", () => {
    const first = applyDelayUpdate({}, delay("a", "1A01", "minor"));
    const moved = applyDelayUpdate(first, { ...delay("b", "1A01", "severe"), runKey: "run-a" });
    expect(Object.values(moved)).toEqual([{ ...delay("b", "1A01", "severe"), runKey: "run-a" }]);
    expect(applyDelayUpdate(moved, { runKey: "run-a", band: "none" })).toEqual({});
  });
});
