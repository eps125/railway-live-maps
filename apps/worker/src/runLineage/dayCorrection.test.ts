import { describe, expect, it } from "vitest";
import type { CandidateScheduleRow, FreshResolutionResult } from "@railway/database";
import { decideDayCorrection } from "./dayCorrection.js";

// CL 0305, 092N08 (owner report 2026-10-31): linked to the 28th's run from 23:24; the 29th's
// activation came at 04:52:58.
const link = {
  cifScheduleId: "273392",
  trafficDay: "2026-10-28",
  trustId: "092N08M529",
  activatedAt: new Date("2026-10-29T04:52:58Z"),
};

function fresh(overrides: Partial<FreshResolutionResult> = {}) {
  return {
    matchStatus: "matched" as const,
    effectiveRow: { id: "273392", cif_train_uid: "C12345" } as CandidateScheduleRow,
    trafficDay: "2026-10-29",
    matchBasis: "trust_activation" as const,
    ...overrides,
  };
}

describe("decideDayCorrection", () => {
  it("moves the link to the activation's day when the resolver agrees — 092N08", () => {
    expect(decideDayCorrection(link, fresh())).toEqual({ move: true, trafficDay: "2026-10-29" });
  });

  it("moves on any match basis, as long as schedule and day agree", () => {
    expect(decideDayCorrection(link, fresh({ matchBasis: "stp_precedence" }))).toEqual({
      move: true,
      trafficDay: "2026-10-29",
    });
  });

  it("waits while the resolver still gives the old day — 305N64 before midnight", () => {
    // Activated 23:05 on the 30th for the 31st; at 23:59 the resolver can only give the 30th.
    expect(
      decideDayCorrection(
        {
          cifScheduleId: "56576",
          trafficDay: "2026-10-30",
          trustId: "305N64M031",
          activatedAt: new Date("2026-10-30T23:05:10Z"),
        },
        fresh({ effectiveRow: { id: "56576" } as CandidateScheduleRow, trafficDay: "2026-10-30" }),
      ),
    ).toEqual({ move: false, reason: "other_day" });
  });

  it("never moves to another schedule, or on an ambiguous or unmatched result", () => {
    expect(
      decideDayCorrection(link, fresh({ effectiveRow: { id: "999" } as CandidateScheduleRow })),
    ).toEqual({ move: false, reason: "other_schedule" });
    expect(
      decideDayCorrection(link, fresh({ matchStatus: "ambiguous", effectiveRow: null })),
    ).toEqual({ move: false, reason: "not_matched" });
    expect(
      decideDayCorrection(link, fresh({ matchStatus: "unmatched", effectiveRow: null })),
    ).toEqual({ move: false, reason: "not_matched" });
  });

  it("leaves a link alone when the TRUST ID has no day or names the run's own day", () => {
    expect(decideDayCorrection({ ...link, trustId: "092N08M5XX" }, fresh())).toEqual({
      move: false,
      reason: "no_day_in_trust_id",
    });
    expect(decideDayCorrection({ ...link, trustId: "092N08M528" }, fresh())).toEqual({
      move: false,
      reason: "same_day",
    });
  });
});
