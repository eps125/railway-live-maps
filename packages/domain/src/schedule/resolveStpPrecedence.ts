/**
 * Milestone 7 (docs/IMPLEMENTATION_PLAN.md M7: "Test STP precedence, natural keys..."). Pure:
 * no DB I/O — the caller fetches every `schedule` row matching a `train_uid` and passes them
 * in as candidates.
 *
 * Precedence (standard CIF/SCHEDULE rule, not spelled out numerically in this repo's docs —
 * sourced from the general STP convention: Cancellation > Overlay > New > Permanent):
 * `C` > `O` > `N` > `P`. In valid data `O` only ever overlays a `P` and `N` only ever exists
 * where no `P` exists, so `O`/`N` should never collide — if they (or any other same-precedence
 * pair) both match, that's ambiguous input, never picked arbitrarily.
 */
export interface ScheduleCandidate {
  stpIndicator: "C" | "N" | "O" | "P";
  scheduleStartDate: string;
  scheduleEndDate: string;
  /** 7-char Mon..Sun runs-on-day bitmask. `null`/missing is treated as "no day restriction
   * known" (matches every day) rather than silently excluding the candidate — the absence of
   * data is not evidence the schedule doesn't run that day. */
  daysRunsBitmask: string | null;
}

export type StpPrecedenceResult<T> =
  | { outcome: "matched"; selected: T }
  | { outcome: "ambiguous"; candidates: T[] }
  | { outcome: "none" };

const PRECEDENCE_RANK: Record<ScheduleCandidate["stpIndicator"], number> = {
  C: 4,
  O: 3,
  N: 2,
  P: 1,
};

export function runsOnDate(candidate: ScheduleCandidate, serviceDate: string): boolean {
  const start = candidate.scheduleStartDate;
  const end = candidate.scheduleEndDate;
  if (serviceDate < start || serviceDate > end) return false;

  if (!candidate.daysRunsBitmask) return true;
  const utcDay = new Date(`${serviceDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const mondayIndexedDay = (utcDay + 6) % 7; // 0 = Monday .. 6 = Sunday
  return candidate.daysRunsBitmask.charAt(mondayIndexedDay) === "1";
}

/** One candidate paired with whichever `serviceDate` it was actually found running on — see
 * `candidatesRunningOnAny`. */
export interface DatedCandidate<T> {
  candidate: T;
  serviceDate: string;
}

/**
 * Traffic-day-boundary fix (docs/adr/0008): like `candidatesRunningOn`, but probes each of
 * `serviceDates` (ordered most-preferred first — callers pass `[today, yesterday]`) rather than a
 * single shared date, and tags every result with whichever date it actually matched. A single
 * shared `serviceDate` string across every candidate is exactly what made an overnight-running
 * train's still-valid, yesterday-dated schedule invisible the instant the calendar rolled over
 * past London midnight (the schedule genuinely doesn't run "today" — it never claimed to — but it
 * still governs the traffic day it was actually created for). A candidate is checked against
 * `serviceDates` in order and tagged with the *first* one it runs on — a candidate can only ever
 * belong to one traffic day at a time even if its date range/bitmask would technically satisfy
 * more than one of the dates being probed (e.g. a genuine daily-running permanent schedule), and
 * preferring the first (most-recent) date keeps today's own service the default pick in the
 * overwhelmingly common non-overnight case.
 */
export function candidatesRunningOnAny<T extends ScheduleCandidate>(
  candidates: T[],
  serviceDates: readonly string[],
): DatedCandidate<T>[] {
  const result: DatedCandidate<T>[] = [];
  for (const candidate of candidates) {
    for (const serviceDate of serviceDates) {
      if (runsOnDate(candidate, serviceDate)) {
        result.push({ candidate, serviceDate });
        break;
      }
    }
  }
  return result;
}

/** Multi-date counterpart to `selectEffectiveSchedule` — same STP precedence rule, applied across
 * whichever of `serviceDates` each candidate actually runs on rather than one shared date. */
export function selectEffectiveScheduleAcrossDates<T extends ScheduleCandidate>(
  candidates: T[],
  serviceDates: readonly string[],
): StpPrecedenceResult<DatedCandidate<T>> {
  const running = candidatesRunningOnAny(candidates, serviceDates);
  if (running.length === 0) return { outcome: "none" };

  const highestRank = Math.max(...running.map((r) => PRECEDENCE_RANK[r.candidate.stpIndicator]));
  const topCandidates = running.filter(
    (r) => PRECEDENCE_RANK[r.candidate.stpIndicator] === highestRank,
  );

  if (topCandidates.length === 1) {
    return { outcome: "matched", selected: topCandidates[0] as DatedCandidate<T> };
  }
  return { outcome: "ambiguous", candidates: topCandidates };
}

/** Milestone 34 (docs/adr/0006): the "running today" half of `selectEffectiveSchedule`, exposed
 * on its own so `resolveRunMatch.ts` can check TRUST activation across the same running-today
 * set before falling to STP precedence — without duplicating the date/bitmask logic. */
export function candidatesRunningOn<T extends ScheduleCandidate>(
  candidates: T[],
  serviceDate: string,
): T[] {
  return candidates.filter((candidate) => runsOnDate(candidate, serviceDate));
}

/** Selects the single schedule that governs `serviceDate` for one `train_uid`'s candidates. */
export function selectEffectiveSchedule<T extends ScheduleCandidate>(
  candidates: T[],
  serviceDate: string,
): StpPrecedenceResult<T> {
  const runningToday = candidates.filter((candidate) => runsOnDate(candidate, serviceDate));
  if (runningToday.length === 0) return { outcome: "none" };

  const highestRank = Math.max(...runningToday.map((c) => PRECEDENCE_RANK[c.stpIndicator]));
  const topCandidates = runningToday.filter((c) => PRECEDENCE_RANK[c.stpIndicator] === highestRank);

  if (topCandidates.length === 1) {
    return { outcome: "matched", selected: topCandidates[0] as T };
  }
  return { outcome: "ambiguous", candidates: topCandidates };
}
