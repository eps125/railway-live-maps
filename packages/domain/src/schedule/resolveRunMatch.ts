import {
  candidatesRunningOn,
  selectEffectiveSchedule,
  type ScheduleCandidate,
} from "./resolveStpPrecedence.js";

/**
 * Milestone 34 (docs/adr/0006 — the berth-run resolver rebuild): decides among an already
 * headcode-matched candidate set which schedule a berth's current occupant actually is.
 *
 * Deliberately does **not** know about position-scoping (STANOX/TIPLOC) at all — that's the
 * caller's job (`apps/api/src/routes/currentRun.ts`), which decides *which* candidate set to
 * pass in: first the SMART-position-scoped set, and only if that set is empty (no SMART coverage
 * for this berth at all) the unscoped nationwide set as a fallback. This function's own `basis`
 * only ever distinguishes `trust_activation` from `stp_precedence` within whichever set it was
 * given — the caller is responsible for relabelling a result computed from the unscoped fallback
 * as the ADR's separate, weaker `headcode_only` tier, since position-scoping (not the internal
 * tie-break method) is what that confidence ranking is actually about.
 */
export type RunMatchBasis = "trust_activation" | "stp_precedence";

export type RunMatchResult<T> =
  | { status: "matched"; basis: RunMatchBasis; selected: T }
  | { status: "ambiguous"; basis: RunMatchBasis; candidates: T[] }
  | { status: "unmatched" };

export interface RunMatchCandidate extends ScheduleCandidate {
  scheduleId: string;
}

/**
 * `activatedScheduleIds` are schedule ids with a `trust_activation` row created since the start
 * of `serviceDate` (London) — checked first (CLAUDE.md rule 6: TRUST activation is the
 * authoritative link when available), falling to pure STP precedence only when no single
 * activated candidate exists among today's running candidates. Two or more tied candidates at
 * either tier is `ambiguous`, never a guess (CLAUDE.md rule 7) — the full tied set is returned so
 * the caller can show it honestly rather than picking arbitrarily.
 */
export function resolveRunMatch<T extends RunMatchCandidate>(
  candidates: T[],
  activatedScheduleIds: ReadonlySet<string>,
  serviceDate: string,
): RunMatchResult<T> {
  const runningToday = candidatesRunningOn(candidates, serviceDate);
  if (runningToday.length === 0) return { status: "unmatched" };

  const activated = runningToday.filter((candidate) =>
    activatedScheduleIds.has(candidate.scheduleId),
  );
  if (activated.length === 1) {
    return { status: "matched", basis: "trust_activation", selected: activated[0] as T };
  }
  if (activated.length > 1) {
    return { status: "ambiguous", basis: "trust_activation", candidates: activated };
  }

  const stpOutcome = selectEffectiveSchedule(runningToday, serviceDate);
  if (stpOutcome.outcome === "matched") {
    return { status: "matched", basis: "stp_precedence", selected: stpOutcome.selected };
  }
  if (stpOutcome.outcome === "ambiguous") {
    return { status: "ambiguous", basis: "stp_precedence", candidates: stpOutcome.candidates };
  }
  return { status: "unmatched" };
}
