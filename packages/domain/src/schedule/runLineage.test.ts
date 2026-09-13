import { describe, expect, it } from "vitest";
import {
  confidenceForBasis,
  capInheritedConfidence,
  evaluateStepChain,
  evaluateBoundaryCorroboration,
  isSameRunIdentity,
} from "./runLineage.js";

describe("confidenceForBasis", () => {
  it("headcode_only is the only weak tier", () => {
    expect(confidenceForBasis("headcode_only")).toBe("weak");
  });

  it("every other basis is solid", () => {
    for (const basis of [
      "trust_activation",
      "stp_precedence",
      "station_berth_timetable",
      "step_chain",
      "boundary_correlated",
    ] as const) {
      expect(confidenceForBasis(basis)).toBe("solid");
    }
  });
});

describe("capInheritedConfidence", () => {
  it("never upgrades a weak source", () => {
    expect(capInheritedConfidence("weak")).toBe("weak");
  });

  it("passes through a solid source", () => {
    expect(capInheritedConfidence("solid")).toBe("solid");
  });
});

describe("evaluateStepChain", () => {
  it("propagates on a clean step from an already-linked occupancy, no feed gap", () => {
    const verdict = evaluateStepChain({
      sourceHasLink: true,
      isCleanStep: true,
      duringFeedGap: false,
    });
    expect(verdict).toEqual({ propagate: true });
  });

  it("does not propagate through a fresh interpose (not a clean step) — covers joins/splits too", () => {
    const verdict = evaluateStepChain({
      sourceHasLink: true,
      isCleanStep: false,
      duringFeedGap: false,
    });
    expect(verdict).toEqual({ propagate: false, reason: "not_a_clean_step" });
  });

  it("does not propagate across a recorded feed gap even on a clean step", () => {
    const verdict = evaluateStepChain({
      sourceHasLink: true,
      isCleanStep: true,
      duringFeedGap: true,
    });
    expect(verdict).toEqual({ propagate: false, reason: "feed_gap" });
  });

  it("does not propagate when the source occupancy was never linked (nothing to inherit)", () => {
    const verdict = evaluateStepChain({
      sourceHasLink: false,
      isCleanStep: true,
      duringFeedGap: false,
    });
    expect(verdict).toEqual({ propagate: false, reason: "source_unlinked" });
  });
});

describe("evaluateBoundaryCorroboration", () => {
  it("never matches on zero candidates", () => {
    expect(
      evaluateBoundaryCorroboration({
        candidateCount: 0,
        scheduleTimingPlausible: true,
        trustMovementContinuity: true,
      }),
    ).toEqual({ status: "none", reason: "no_candidate" });
  });

  it("is ambiguous when more than one candidate is plausible, even with corroboration", () => {
    expect(
      evaluateBoundaryCorroboration({
        candidateCount: 2,
        scheduleTimingPlausible: true,
        trustMovementContinuity: true,
      }),
    ).toEqual({ status: "ambiguous" });
  });

  it("never matches on a single candidate with no corroboration (not headcode alone)", () => {
    expect(
      evaluateBoundaryCorroboration({
        candidateCount: 1,
        scheduleTimingPlausible: false,
        trustMovementContinuity: false,
      }),
    ).toEqual({ status: "none", reason: "no_corroboration" });
  });

  it("matches on schedule timing alone", () => {
    expect(
      evaluateBoundaryCorroboration({
        candidateCount: 1,
        scheduleTimingPlausible: true,
        trustMovementContinuity: false,
      }),
    ).toEqual({ status: "matched" });
  });

  it("matches on trust movement continuity alone", () => {
    expect(
      evaluateBoundaryCorroboration({
        candidateCount: 1,
        scheduleTimingPlausible: false,
        trustMovementContinuity: true,
      }),
    ).toEqual({ status: "matched" });
  });
});

describe("isSameRunIdentity", () => {
  const base = { cifScheduleId: "180961", cifTrainUid: "C00574", trafficDay: "2026-09-13" };

  it("is true for an identical identity", () => {
    expect(isSameRunIdentity(base, { ...base })).toBe(true);
  });

  it("is false when the schedule id differs", () => {
    expect(isSameRunIdentity(base, { ...base, cifScheduleId: "999" })).toBe(false);
  });

  it("is false when the traffic day differs", () => {
    expect(isSameRunIdentity(base, { ...base, trafficDay: "2026-09-14" })).toBe(false);
  });
});
