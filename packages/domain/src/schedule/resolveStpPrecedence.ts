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

function runsOnDate(candidate: ScheduleCandidate, serviceDate: string): boolean {
  const start = candidate.scheduleStartDate;
  const end = candidate.scheduleEndDate;
  if (serviceDate < start || serviceDate > end) return false;

  if (!candidate.daysRunsBitmask) return true;
  const utcDay = new Date(`${serviceDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const mondayIndexedDay = (utcDay + 6) % 7; // 0 = Monday .. 6 = Sunday
  return candidate.daysRunsBitmask.charAt(mondayIndexedDay) === "1";
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
