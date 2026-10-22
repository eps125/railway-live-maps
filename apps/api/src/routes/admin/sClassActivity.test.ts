import { describe, expect, it } from "vitest";
import {
  SClassActivityCache,
  mergeActivity,
  planActivityRanges,
  type ActivityMap,
} from "./sClassActivity.js";

const at = (iso: string): Date => new Date(iso);
const act = (entries: Array<[string, string, number]>): ActivityMap =>
  new Map(entries.map(([key, last, changes]) => [key, { lastChangedAt: at(last), changes }]));

describe("planActivityRanges", () => {
  it("splits a long window into settled whole days and the partial days at its ends", () => {
    const now = at("2026-10-22T18:00:00Z");
    const plan = planActivityRanges(at("2026-10-19T18:00:00Z"), now, now);
    expect(plan.days.map((d) => d.toISOString())).toEqual([
      "2026-10-20T00:00:00.000Z",
      "2026-10-21T00:00:00.000Z",
    ]);
    expect(plan.ranges.map(([a, b]) => [a.toISOString(), b.toISOString()])).toEqual([
      ["2026-10-19T18:00:00.000Z", "2026-10-20T00:00:00.000Z"],
      ["2026-10-22T00:00:00.000Z", "2026-10-22T18:00:00.000Z"],
    ]);
  });

  it("treats a day that ended in the last 15 minutes as not settled yet", () => {
    const now = at("2026-10-22T00:10:00Z");
    const plan = planActivityRanges(at("2026-10-20T00:10:00Z"), now, now);
    // 21 Oct ended 10 minutes ago: it is counted with the rest as a range, not kept as a day
    expect(plan.days).toEqual([]);
    expect(plan.ranges).toEqual([[at("2026-10-20T00:10:00Z"), now]]);
  });

  it("keeps a short window as one range", () => {
    const now = at("2026-10-22T18:00:00Z");
    const plan = planActivityRanges(at("2026-10-21T18:00:00Z"), now, now);
    expect(plan.days).toEqual([]);
    expect(plan.ranges).toEqual([[at("2026-10-21T18:00:00Z"), now]]);
  });
});

describe("mergeActivity", () => {
  it("adds counts and keeps the latest change", () => {
    const merged = mergeActivity([
      act([["03:2", "2026-10-20T10:00:00Z", 4]]),
      act([
        ["03:2", "2026-10-21T09:00:00Z", 3],
        ["04:0", "2026-10-21T08:00:00Z", 1],
      ]),
    ]);
    expect(merged.get("03:2")).toEqual({ lastChangedAt: at("2026-10-21T09:00:00Z"), changes: 7 });
    expect(merged.get("04:0")?.changes).toBe(1);
  });
});

describe("SClassActivityCache", () => {
  const NOW = at("2026-10-22T18:00:00Z");

  function harness(queryMs = 0, fail: (from: Date) => boolean = () => false) {
    const calls: Array<{ from: string; to: string }> = [];
    let running = 0;
    let maxRunning = 0;
    const cache = new SClassActivityCache(
      async (_area, from, to) => {
        calls.push({ from: from.toISOString(), to: to.toISOString() });
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, queryMs));
        running--;
        if (fail(from)) throw new Error("canceling statement due to statement timeout");
        return act([["03:2", from.toISOString(), 1]]);
      },
      { now: () => NOW, waitMs: 1_000, ttlMs: 60_000 },
    );
    return { cache, calls, maxRunning: () => maxRunning };
  }

  it("counts a 14-day window as settled days plus the two partial ends", async () => {
    const h = harness();
    const result = await h.cache.get("R1", 336);
    expect(result.complete).toBe(true);
    expect(h.calls).toHaveLength(15); // 13 whole days, the partial first day and today so far
    expect(result.activity.get("03:2")?.changes).toBe(15);
  });

  it("shares one computation between concurrent requests and runs one query at a time", async () => {
    const h = harness(5);
    const [a, b, c] = await Promise.all([
      h.cache.get("R1", 168),
      h.cache.get("R1", 168),
      h.cache.get("R2", 168),
    ]);
    expect(a).toBe(b);
    expect(c.complete).toBe(true);
    expect(h.calls).toHaveLength(2 * 8); // R1 once, R2 once
    expect(h.maxRunning()).toBe(1);
  });

  it("reuses settled days when the window is asked for again", async () => {
    const h = harness();
    await h.cache.get("R1", 336);
    const first = h.calls.length;
    await h.cache.get("R1", 168); // a different window: only its two partial ends are new
    expect(h.calls.length - first).toBe(2);
  });

  it("answers within the wait limit while a long window is still being counted", async () => {
    const stuck = new SClassActivityCache(() => new Promise<ActivityMap>(() => undefined), {
      now: () => NOW,
      waitMs: 20,
    });
    const result = await stuck.get("R1", 336);
    expect(result.complete).toBe(false);
    expect(result.activity.size).toBe(0);
  });

  it("reports a day that failed as incomplete and does not keep it", async () => {
    const failing = at("2026-10-20T00:00:00Z").getTime();
    const h = harness(0, (from) => from.getTime() === failing);
    const result = await h.cache.get("R1", 336);
    expect(result.complete).toBe(false);
    expect(result.activity.get("03:2")?.changes).toBe(14);
  });
});
