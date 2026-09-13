/**
 * Milestone 35 (docs/adr/0006 addendum): the `station_berth_timetable` matchBasis tier — pure
 * time parsing/comparison helpers, no DB I/O.
 *
 * Deliberately does **not** filter out a candidate whose scheduled time has "already passed"
 * relative to now. A signaller interposes a TD headcode whenever the train is physically in the
 * berth, which is routinely hours before its scheduled departure (a train stabled overnight, or
 * simply early for its next working) — a hard "already passed" cutoff would wrongly exclude that
 * correct, early candidate. It also can't tell a genuinely-finished working apart from a running-
 * late one without real-time evidence (which, if it existed, would already have been used at the
 * `trust_activation` tier above this one) — so instead of guessing "has this happened yet",
 * candidates are ranked purely by closeness to now, in either direction.
 */

/** Parses a CIF `HHMM` / `HHMMH` (half-minute) raw time string into minutes since midnight
 * (0-1439.5). Returns `null` for a missing or unparseable string — never throws (CLAUDE.md: raw
 * schedule data is retained as-is, not silently repaired). */
export function parseCifTimeToMinutes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const half = raw.endsWith("H");
  const digits = half ? raw.slice(0, -1) : raw;
  if (!/^\d{4}$/.test(digits)) return null;
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes + (half ? 0.5 : 0);
}

/** Distance between two minutes-since-midnight values, wrapping at the 1440-minute day boundary
 * (so 23:58 and 00:02 are 4 minutes apart, not 1436) — a deliberately simple day model, matching
 * `currentRun.ts`'s existing "close enough, not WTT 02:00-boundary precise" bar (`londonToday`'s
 * own doc comment) rather than modelling `next_day` offsets exactly. */
export function circularDiffMinutes(a: number, b: number): number {
  const diff = Math.abs(a - b) % 1440;
  return Math.min(diff, 1440 - diff);
}

/**
 * Among `candidates` (each optionally carrying a parsed calling-point time), picks whichever is
 * closest to `nowMinutes`. Candidates with no parseable time are ignored. Two or more candidates
 * exactly tied for closest are all returned (CLAUDE.md rule 7 — never guess between a genuine
 * tie); an empty result means nothing here had a usable time to rank by.
 */
export function closestToNow<T>(
  candidates: T[],
  callingTimeMinutes: (candidate: T) => number | null,
  nowMinutes: number,
): T[] {
  let bestDiff = Infinity;
  let best: T[] = [];
  for (const candidate of candidates) {
    const minutes = callingTimeMinutes(candidate);
    if (minutes === null) continue;
    const diff = circularDiffMinutes(minutes, nowMinutes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [candidate];
    } else if (diff === bestDiff) {
      best.push(candidate);
    }
  }
  return best;
}
