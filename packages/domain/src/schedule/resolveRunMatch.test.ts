import { describe, expect, it } from "vitest";
import { resolveRunMatch, type RunMatchCandidate } from "./resolveRunMatch.js";

function candidate(overrides: Partial<RunMatchCandidate> = {}): RunMatchCandidate {
  return {
    scheduleId: "1",
    stpIndicator: "P",
    scheduleStartDate: "2026-01-01",
    scheduleEndDate: "2026-12-31",
    daysRunsBitmask: "1111111",
    ...overrides,
  };
}

// 2026-08-10 is a Monday.
const A_MONDAY = "2026-08-10";

describe("resolveRunMatch (Milestone 34, docs/adr/0006)", () => {
  it("matches on trust_activation when exactly one running-today candidate has one, even though it isn't the STP-precedence winner", () => {
    // Two Permanent schedules (same precedence, would be ambiguous by STP alone) — only one
    // has an activation today. Rule 6: activation is authoritative when available.
    const p1 = candidate({ scheduleId: "1" });
    const p2 = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([p1, p2], new Set(["2"]), A_MONDAY);
    expect(result).toEqual({ status: "matched", basis: "trust_activation", selected: p2 });
  });

  it("two activated candidates is ambiguous at the trust_activation tier — never falls through to STP as a tie-break", () => {
    const p1 = candidate({ scheduleId: "1" });
    const p2 = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([p1, p2], new Set(["1", "2"]), A_MONDAY);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.basis).toBe("trust_activation");
      expect(result.candidates).toEqual([p1, p2]);
    }
  });

  it("falls to stp_precedence when no candidate is activated", () => {
    const p = candidate({ scheduleId: "1", stpIndicator: "P" });
    const o = candidate({ scheduleId: "2", stpIndicator: "O" });
    const result = resolveRunMatch([p, o], new Set(), A_MONDAY);
    expect(result).toEqual({ status: "matched", basis: "stp_precedence", selected: o });
  });

  it("is ambiguous at the stp_precedence tier when STP itself can't resolve it and nothing is activated", () => {
    const p1 = candidate({ scheduleId: "1" });
    const p2 = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([p1, p2], new Set(), A_MONDAY);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.basis).toBe("stp_precedence");
      expect(result.candidates).toEqual([p1, p2]);
    }
  });

  it("is unmatched when no candidate runs today at all", () => {
    const stale = candidate({ scheduleStartDate: "2020-01-01", scheduleEndDate: "2020-12-31" });
    const result = resolveRunMatch([stale], new Set(["1"]), A_MONDAY);
    expect(result).toEqual({ status: "unmatched" });
  });

  it("is unmatched with an empty candidate list", () => {
    expect(resolveRunMatch([], new Set(), A_MONDAY)).toEqual({ status: "unmatched" });
  });

  it("only checks activation among candidates actually running today, not a stale one that happens to be activated", () => {
    const stale = candidate({
      scheduleId: "1",
      scheduleStartDate: "2020-01-01",
      scheduleEndDate: "2020-12-31",
    });
    const running = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([stale, running], new Set(["1"]), A_MONDAY);
    // "1" is activated but doesn't run today, so only "2" is a real candidate — falls to
    // stp_precedence (no activation among the running-today set) and matches on "2" alone.
    expect(result).toEqual({ status: "matched", basis: "stp_precedence", selected: running });
  });
});
