import { describe, expect, it } from "vitest";
import { parseCifTimeToMinutes, circularDiffMinutes, closestToNow } from "./stationBerthTiming.js";

describe("parseCifTimeToMinutes", () => {
  it("parses a plain HHMM time", () => {
    expect(parseCifTimeToMinutes("0958")).toBe(9 * 60 + 58);
    expect(parseCifTimeToMinutes("0000")).toBe(0);
    expect(parseCifTimeToMinutes("2359")).toBe(23 * 60 + 59);
  });

  it("parses a half-minute HHMMH time", () => {
    expect(parseCifTimeToMinutes("0958H")).toBe(9 * 60 + 58.5);
  });

  it("returns null for missing or malformed input, never throws", () => {
    expect(parseCifTimeToMinutes(null)).toBeNull();
    expect(parseCifTimeToMinutes(undefined)).toBeNull();
    expect(parseCifTimeToMinutes("")).toBeNull();
    expect(parseCifTimeToMinutes("abcd")).toBeNull();
    expect(parseCifTimeToMinutes("99999")).toBeNull();
    expect(parseCifTimeToMinutes("2500")).toBeNull(); // hour out of range
    expect(parseCifTimeToMinutes("0060")).toBeNull(); // minute out of range
  });
});

describe("circularDiffMinutes", () => {
  it("is the plain difference for two times well within the same day", () => {
    expect(circularDiffMinutes(600, 610)).toBe(10);
    expect(circularDiffMinutes(610, 600)).toBe(10);
  });

  it("wraps across midnight rather than counting the long way round", () => {
    // 23:58 (1438) and 00:02 (2) are 4 minutes apart, not 1436.
    expect(circularDiffMinutes(1438, 2)).toBe(4);
  });

  it("is zero for the same time", () => {
    expect(circularDiffMinutes(600, 600)).toBe(0);
  });
});

describe("closestToNow (Milestone 35 — station_berth_timetable disambiguation)", () => {
  function byTime<T extends { time: number | null }>(c: T): number | null {
    return c.time;
  }

  it("picks the candidate closest to now even when it's hours in the future (early interpose)", () => {
    // The train was interposed at 05:00 for a 10:00 departure — "now" is still 05:00-ish, but
    // this candidate is the only one with a real time, so it wins regardless of the gap.
    const early = { id: "early", time: 10 * 60 };
    const result = closestToNow([early], byTime, 5 * 60);
    expect(result).toEqual([early]);
  });

  it("picks the candidate closest to now even when its scheduled time has already passed (running late)", () => {
    // Scheduled 10:00, it's now 10:15 (15 min late) — must not be excluded just because its
    // nominal time is "in the past".
    const late = { id: "late", time: 10 * 60 };
    const decoy = { id: "decoy", time: 22 * 60 }; // a same-headcode working much later today
    const result = closestToNow([late, decoy], byTime, 10 * 60 + 15);
    expect(result).toEqual([late]);
  });

  it("disambiguates a same-headcode-runs-twice-today diagram by picking the imminent one", () => {
    const morning = { id: "morning", time: 8 * 60 };
    const evening = { id: "evening", time: 18 * 60 };
    // It's 17:50 — clearly heading toward the evening working, not the morning one long done.
    const result = closestToNow([morning, evening], byTime, 17 * 60 + 50);
    expect(result).toEqual([evening]);
  });

  it("returns every candidate exactly tied for closest, rather than guessing", () => {
    const a = { id: "a", time: 10 * 60 };
    const b = { id: "b", time: 10 * 60 + 10 };
    // now = 10:05 — exactly 5 minutes from each.
    const result = closestToNow([a, b], byTime, 10 * 60 + 5);
    expect(result).toEqual([a, b]);
  });

  it("ignores candidates with no parseable time", () => {
    const known = { id: "known", time: 10 * 60 };
    const unknown = { id: "unknown", time: null };
    const result = closestToNow([known, unknown], byTime, 10 * 60);
    expect(result).toEqual([known]);
  });

  it("returns an empty array when nothing has a usable time", () => {
    const unknown = { id: "unknown", time: null };
    expect(closestToNow([unknown], byTime, 600)).toEqual([]);
  });
});
