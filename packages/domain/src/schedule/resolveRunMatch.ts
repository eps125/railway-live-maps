import {
  candidatesRunningOn,
  selectEffectiveSchedule,
  type ScheduleCandidate,
} from "./resolveStpPrecedence.js";
import { closestToNow } from "./stationBerthTiming.js";

/**
 * Milestone 34 (docs/adr/0006 — the berth-run resolver rebuild), Milestone 35 addendum
 * (`station_berth_timetable`): decides among an already headcode-matched candidate set which
 * schedule a berth's current occupant actually is.
 *
 * Deliberately does **not** know about position-scoping (STANOX/TIPLOC) at all — that's the
 * caller's job (`apps/api/src/routes/currentRun.ts`), which decides *which* candidate set to
 * pass in: first the SMART-position-scoped set, and only if that set is empty (no SMART coverage
 * for this berth at all) the unscoped nationwide set as a fallback. This function's own `basis`
 * only ever distinguishes `trust_activation`/`stp_precedence`/`station_berth_timetable` within
 * whichever set it was given — the caller is responsible for relabelling a result computed from
 * the unscoped fallback as the ADR's separate, weaker `headcode_only` tier, since position-
 * scoping (not the internal tie-break method) is what that confidence ranking is actually about.
 */
export type RunMatchBasis = "trust_activation" | "stp_precedence" | "station_berth_timetable";

export type RunMatchResult<T> =
  | { status: "matched"; basis: RunMatchBasis; selected: T }
  | { status: "ambiguous"; basis: RunMatchBasis; candidates: T[] }
  | { status: "unmatched" };

export interface RunMatchCandidate extends ScheduleCandidate {
  scheduleId: string;
}

/**
 * Milestone 35: when STP precedence alone can't resolve a tie among candidates at a berth known
 * to be a real station, break it by which candidate's calling time at that station is closest to
 * the current moment — not by how close it is to when the berth was entered, since a signaller
 * interposes a headcode whenever the train is physically present, which is routinely hours
 * before its scheduled departure (a train stabled overnight, or simply early for its working).
 * `callingTimeMinutes` returns each candidate's scheduled time there (minutes since midnight,
 * `null` if unknown); `nowMinutes` is the current moment, same units.
 */
export interface StationTiming<T> {
  callingTimeMinutes: (candidate: T) => number | null;
  nowMinutes: number;
}

/**
 * `activatedScheduleIds` are schedule ids with a `trust_activation` row created since the start
 * of `serviceDate` (London) — checked first (CLAUDE.md rule 6: TRUST activation is the
 * authoritative link when available), falling to pure STP precedence only when no single
 * activated candidate exists among today's running candidates, and then (only when `timing` is
 * given — i.e. this berth is a known station) to closest-to-now among the STP-tied candidates.
 * Two or more tied candidates at any tier is `ambiguous`, never a guess (CLAUDE.md rule 7) — the
 * full tied set is returned so the caller can show it honestly rather than picking arbitrarily.
 */
export function resolveRunMatch<T extends RunMatchCandidate>(
  candidates: T[],
  activatedScheduleIds: ReadonlySet<string>,
  serviceDate: string,
  timing?: StationTiming<T>,
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
  if (stpOutcome.outcome === "none") {
    // Can't actually happen: `runningToday` (which `selectEffectiveSchedule` re-derives
    // internally) is already non-empty at this point — kept only so TS can narrow below.
    return { status: "unmatched" };
  }

  if (timing) {
    const closest = closestToNow(
      stpOutcome.candidates,
      timing.callingTimeMinutes,
      timing.nowMinutes,
    );
    if (closest.length === 1) {
      return { status: "matched", basis: "station_berth_timetable", selected: closest[0] as T };
    }
    if (closest.length > 1) {
      return { status: "ambiguous", basis: "station_berth_timetable", candidates: closest };
    }
  }

  return { status: "ambiguous", basis: "stp_precedence", candidates: stpOutcome.candidates };
}
