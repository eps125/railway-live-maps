import { describe, expect, it } from "vitest";
import { resolveBerthRun, type RunCandidate } from "./resolveBerthRun.js";

function candidate(overrides: Partial<RunCandidate>): RunCandidate {
  return {
    trainRunId: "run-1",
    hasMatchedSchedule: false,
    temporallyPlausible: false,
    recentContinuity: false,
    smartStanoxMatch: false,
    ...overrides,
  };
}

describe("resolveBerthRun", () => {
  it("no candidates at all is unmatched with an empty candidate list", () => {
    const result = resolveBerthRun([]);
    expect(result).toEqual({ status: "unmatched", candidates: [] });
  });

  it("a single candidate with zero evidence beyond the signalling-id match is unmatched, not guessed", () => {
    const result = resolveBerthRun([candidate({ trainRunId: "run-1" })]);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ trainRunId: "run-1", score: 0 });
  });

  it("a single strong candidate (schedule-linked + temporally plausible + continuity + SMART match) is matched", () => {
    const result = resolveBerthRun([
      candidate({
        trainRunId: "run-1",
        hasMatchedSchedule: true,
        temporallyPlausible: true,
        recentContinuity: true,
        smartStanoxMatch: true,
      }),
    ]);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.selectedTrainRunId).toBe("run-1");
    expect(result.confidence).toBe(1);
  });

  it("continuity from a preceding occupancy breaks a tie between two otherwise-equal candidates", () => {
    const withContinuity = candidate({
      trainRunId: "with-continuity",
      hasMatchedSchedule: true,
      recentContinuity: true,
    });
    const withoutContinuity = candidate({
      trainRunId: "without-continuity",
      hasMatchedSchedule: true,
    });
    const result = resolveBerthRun([withoutContinuity, withContinuity]);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.selectedTrainRunId).toBe("with-continuity");
  });

  it("a missing SMART match for one step no longer flips a continuity-backed run to ambiguous", () => {
    // Regression for the real-world "matched, one step ambiguous, matched again" flap: two
    // same-headcode candidates tie on schedule-linked + temporally-plausible whenever SMART
    // coverage is absent for a particular berth; continuity (this run was *just* matched) should
    // still break the tie even though SMART can't.
    const justMatched = candidate({
      trainRunId: "just-matched",
      hasMatchedSchedule: true,
      temporallyPlausible: true,
      recentContinuity: true,
    });
    const otherHeadcodeSharer = candidate({
      trainRunId: "other-sharer",
      hasMatchedSchedule: true,
      temporallyPlausible: true,
    });
    const result = resolveBerthRun([otherHeadcodeSharer, justMatched]);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.selectedTrainRunId).toBe("just-matched");
  });

  it("a schedule-linked candidate beats a non-linked one with otherwise equal evidence", () => {
    const linked = candidate({ trainRunId: "linked", hasMatchedSchedule: true });
    const unlinked = candidate({ trainRunId: "unlinked", hasMatchedSchedule: false });
    const result = resolveBerthRun([unlinked, linked]);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.selectedTrainRunId).toBe("linked");
  });

  it("a SMART/STANOX match breaks a tie between two otherwise-equal candidates", () => {
    const withSmart = candidate({
      trainRunId: "with-smart",
      hasMatchedSchedule: true,
      smartStanoxMatch: true,
    });
    const withoutSmart = candidate({ trainRunId: "without-smart", hasMatchedSchedule: true });
    const result = resolveBerthRun([withoutSmart, withSmart]);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.selectedTrainRunId).toBe("with-smart");
  });

  it("two equally-plausible candidates are ambiguous, never silently picked (CLAUDE.md rule 5)", () => {
    const a = candidate({
      trainRunId: "run-a",
      hasMatchedSchedule: true,
      temporallyPlausible: true,
    });
    const b = candidate({
      trainRunId: "run-b",
      hasMatchedSchedule: true,
      temporallyPlausible: true,
    });
    const result = resolveBerthRun([a, b]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates.map((c) => c.trainRunId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("an ambiguous result still reports every candidate's evidence, not just the tied leaders", () => {
    const strong1 = candidate({ trainRunId: "strong-1", hasMatchedSchedule: true });
    const strong2 = candidate({ trainRunId: "strong-2", hasMatchedSchedule: true });
    const weak = candidate({ trainRunId: "weak" });
    const result = resolveBerthRun([strong1, strong2, weak]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(3);
  });
});
