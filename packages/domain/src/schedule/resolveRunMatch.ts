import {
  candidatesRunningOnAny,
  selectEffectiveScheduleAcrossDates,
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
  | { status: "matched"; basis: RunMatchBasis; selected: T; trafficDay: string }
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
 * `activatedDatesByScheduleId` maps a schedule id to the set of calendar dates it has a
 * `trust_activation` row actually dated on (the activation row's own `created` timestamp,
 * resolved to a London calendar date — never the query's cutoff bound). Checked first (CLAUDE.md
 * rule 6: TRUST activation is the authoritative link when available), falling to pure STP
 * precedence only when no single activated candidate exists among the running candidates, and
 * then (only when `timing` is given — i.e. this berth is a known station) to closest-to-now among
 * the STP-tied candidates. Two or more tied candidates at any tier is `ambiguous`, never a guess
 * (CLAUDE.md rule 7) — the full tied set is returned so the caller can show it honestly rather
 * than picking arbitrarily.
 *
 * `serviceDates` is ordered most-preferred first (callers pass `[today, yesterday]`) — traffic-
 * day-boundary fix (docs/adr/0008): a single shared date made an overnight train's still-valid,
 * yesterday-dated schedule invisible the instant the calendar rolled over past London midnight.
 * Each candidate is independently checked against every date in `serviceDates` and matched
 * against the first (most-preferred) one it actually runs on — see
 * `candidatesRunningOnAny`/`selectEffectiveScheduleAcrossDates`. A `matched` result's own
 * `trafficDay` says which date actually produced it, since that (not necessarily "today") is the
 * real traffic day the caller must use downstream (TRUST activation detail, unit allocation,
 * the link this match gets recorded against).
 *
 * ADR 0008 addendum (2026-09-15): the TRUST activation check must be checked **per resolved
 * date**, not "activated anywhere in the widened window" — a flat scheduleId membership test was
 * exactly what widening the query window to catch an overnight train's pre-midnight activation
 * also broke: a *daily-repeating* schedule sharing a headcode (real incident: PX 0107, headcode
 * `1Y61`, schedules G89843 and G89845 both call there, at 10:52 and 20:50 respectively) gets a
 * genuinely distinct `trust_activation` row for each real day it runs. Once the query window
 * widened to include yesterday, G89845's activation from *yesterday evening* (its own prior
 * day's working, hours before today's 20:50 service is even due) started showing as "activated"
 * for today's occurrence too, alongside G89843's real same-morning activation — falsely reporting
 * `ambiguous` instead of matching G89843 cleanly. Matching each candidate's resolved `serviceDate`
 * against the specific date its activation was actually dated on (not just the schedule id) fixes
 * both cases correctly: an overnight train's activation is dated on the same day its resolved
 * `serviceDate` correctly comes out to (yesterday), so it still counts; a same-headcode sibling's
 * stale prior-day activation no longer collides with today's occurrence of a different schedule.
 */
export function resolveRunMatch<T extends RunMatchCandidate>(
  candidates: T[],
  activatedDatesByScheduleId: ReadonlyMap<string, ReadonlySet<string>>,
  serviceDates: readonly string[],
  timing?: StationTiming<T>,
): RunMatchResult<T> {
  const running = candidatesRunningOnAny(candidates, serviceDates);
  if (running.length === 0) return { status: "unmatched" };

  const activated = running.filter((dated) =>
    activatedDatesByScheduleId.get(dated.candidate.scheduleId)?.has(dated.serviceDate),
  );
  if (activated.length === 1) {
    const only = activated[0] as (typeof activated)[number];
    return {
      status: "matched",
      basis: "trust_activation",
      selected: only.candidate,
      trafficDay: only.serviceDate,
    };
  }
  if (activated.length > 1) {
    return {
      status: "ambiguous",
      basis: "trust_activation",
      candidates: activated.map((dated) => dated.candidate),
    };
  }

  const stpOutcome = selectEffectiveScheduleAcrossDates(candidates, serviceDates);
  if (stpOutcome.outcome === "matched") {
    return {
      status: "matched",
      basis: "stp_precedence",
      selected: stpOutcome.selected.candidate,
      trafficDay: stpOutcome.selected.serviceDate,
    };
  }
  if (stpOutcome.outcome === "none") {
    // Can't actually happen: `running` (which `selectEffectiveScheduleAcrossDates` re-derives
    // internally) is already non-empty at this point — kept only so TS can narrow below.
    return { status: "unmatched" };
  }

  if (timing) {
    const closest = closestToNow(
      stpOutcome.candidates,
      (dated) => timing.callingTimeMinutes(dated.candidate),
      timing.nowMinutes,
    );
    if (closest.length === 1) {
      const only = closest[0] as (typeof closest)[number];
      return {
        status: "matched",
        basis: "station_berth_timetable",
        selected: only.candidate,
        trafficDay: only.serviceDate,
      };
    }
    if (closest.length > 1) {
      return {
        status: "ambiguous",
        basis: "station_berth_timetable",
        candidates: closest.map((dated) => dated.candidate),
      };
    }
  }

  return {
    status: "ambiguous",
    basis: "stp_precedence",
    candidates: stpOutcome.candidates.map((dated) => dated.candidate),
  };
}
