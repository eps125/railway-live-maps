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
  /** CIF train UID. STP precedence only ever compares schedules of the same UID: an overlay of
   * one train says nothing about another train that happens to share its headcode. Omitted (as
   * in older tests) = every candidate counts as the same train. */
  trainUid?: string | undefined;
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

/**
 * STP fix (2026-10-01, owner report: delay colours missing; PX/M9 1N58). Whether `candidate` is
 * the schedule its own train actually runs to on `serviceDate`: it runs that day, is not itself a
 * cancellation, and no other schedule of the same train UID with higher precedence (C > O > N >
 * P) also covers that day. `sameUid` should hold *every* schedule of the candidates' UIDs, not
 * just the ones that matched by headcode and position: a cancellation usually carries no headcode
 * or calling points (131k of 131k current C rows on 2026-10-01, bar 76), and an overlay may run a
 * different route. Two same-UID schedules of equal precedence both govern — conflicting input is
 * left for the caller to report, never picked between.
 */
export function governsDate(
  candidate: ScheduleCandidate,
  serviceDate: string,
  sameUid: readonly ScheduleCandidate[],
): boolean {
  if (candidate.stpIndicator === "C" || !runsOnDate(candidate, serviceDate)) return false;
  const rank = PRECEDENCE_RANK[candidate.stpIndicator];
  const uid = candidate.trainUid ?? null;
  return !sameUid.some(
    (other) =>
      (other.trainUid ?? null) === uid &&
      PRECEDENCE_RANK[other.stpIndicator] > rank &&
      runsOnDate(other, serviceDate),
  );
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
  dateChoice?: ServiceDateChoice<T>,
  /** Given: only dates on which the candidate governs its train (see `governsDate`). */
  sameUid?: readonly ScheduleCandidate[],
): DatedCandidate<T>[] {
  const result: DatedCandidate<T>[] = [];
  for (const candidate of candidates) {
    const dates = serviceDates.filter((serviceDate) =>
      sameUid ? governsDate(candidate, serviceDate, sameUid) : runsOnDate(candidate, serviceDate),
    );
    const first = dates[0];
    if (first === undefined) continue;
    result.push({
      candidate,
      serviceDate: chooseServiceDate(candidate, dates, serviceDates, dateChoice),
    });
  }
  return result;
}

/**
 * Overnight fix (2026-10-01, owner report: Caledonian Sleeper 1S25/1S26/1M11/1M16 never coloured
 * by delay): which of the probed dates a schedule valid on *more than one* of them is running for
 * right now. Preferring the most recent date was wrong for any overnight train that runs on
 * consecutive days: the Tue-Thu 1M11 (Glasgow 23:40) seen at Carlisle at 00:30 on Thursday was
 * resolved to Thursday's run — which hadn't left yet — instead of Wednesday's, so it missed its
 * TRUST activation (dated Wednesday) and the delay lookup found nothing all night.
 *
 * `originDepartureMinutes` is the schedule's departure from its origin (minutes after midnight
 * of its own traffic day). The occurrence chosen is the one whose departure is nearest to now,
 * earlier or later: 50 minutes after Wednesday's 23:40 beats 23 hours before Thursday's. A
 * same-headcode run from yesterday that has actually finished is still excluded separately, by
 * TRUST movement evidence (`alreadyPassedScheduleIds`).
 */
export interface ServiceDateChoice<T> {
  originDepartureMinutes: (candidate: T) => number | null;
  /** Now, in minutes after midnight of `serviceDates[0]` (today). */
  nowMinutes: number;
}

/** `serviceDates` are consecutive days going back from today: index = days before today. A
 * candidate running on one date, or with no known departure, keeps the most recent date. */
function chooseServiceDate<T>(
  candidate: T,
  runningDates: readonly string[],
  serviceDates: readonly string[],
  dateChoice: ServiceDateChoice<T> | undefined,
): string {
  const first = runningDates[0] as string;
  if (runningDates.length === 1 || !dateChoice) return first;
  const departure = dateChoice.originDepartureMinutes(candidate);
  if (departure === null) return first;
  let best = first;
  let bestDistance = Infinity;
  for (const date of runningDates) {
    const daysBack = serviceDates.indexOf(date);
    const distance = Math.abs(dateChoice.nowMinutes + daysBack * 1440 - departure);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = date;
    }
  }
  return best;
}

/** Multi-date counterpart to `selectEffectiveSchedule` — same STP precedence rule, applied across
 * whichever of `serviceDates` each candidate actually runs on rather than one shared date. */
export function selectEffectiveScheduleAcrossDates<T extends ScheduleCandidate>(
  candidates: T[],
  serviceDates: readonly string[],
  dateChoice?: ServiceDateChoice<T>,
): StpPrecedenceResult<DatedCandidate<T>> {
  const running = candidatesRunningOnAny(candidates, serviceDates, dateChoice);
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
