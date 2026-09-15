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
 * `activatedScheduleIds` are schedule ids with a `trust_activation` row created since the start
 * of whichever `serviceDates` covers the widest net (checked by the caller's SQL) — checked first
 * (CLAUDE.md rule 6: TRUST activation is the authoritative link when available), falling to pure
 * STP precedence only when no single activated candidate exists among the running candidates, and
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
 */
export function resolveRunMatch<T extends RunMatchCandidate>(
  candidates: T[],
  activatedScheduleIds: ReadonlySet<string>,
  serviceDates: readonly string[],
  timing?: StationTiming<T>,
): RunMatchResult<T> {
  const running = candidatesRunningOnAny(candidates, serviceDates);
  if (running.length === 0) return { status: "unmatched" };

  const activated = running.filter((dated) => activatedScheduleIds.has(dated.candidate.scheduleId));
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
