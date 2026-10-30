import { decodeTrustMovementFlags, signedVariationMinutes } from "@railway/domain";
import { londonMinutesSinceMidnight } from "@railway/database";

/** One TRUST movement of the run, as read from `trust_movement`. */
export interface RunMovementRow {
  loc_stanox: string | null;
  platform: string | null;
  actual_timestamp: Date | null;
  planned_timestamp: Date | null;
  timetable_variation: number | null;
  flags: number | null;
  created: Date;
}

/** The working times of one calling point, enough to tell which of several sharing a STANOX a
 * report belongs to. */
export interface RunLocationTimes {
  tiploc: string;
  arrivalWorking: string | null;
  departureWorking: string | null;
  passWorking: string | null;
}

export interface RunningReport {
  actual: string;
  /** Positive late, negative early, 0 on time; `null` off route. */
  minutesLate: number | null;
  platform: string | null;
}

/** 2026-10-30 (popup live running): what TRUST reported at one calling point. A pass is reported
 * by TRUST as a departure, so it lands in `departure`. */
export interface LocationRunning {
  arrival: RunningReport | null;
  departure: RunningReport | null;
}

/** `HHMM` or `HHMMH` working time → minutes after midnight (the half-minute dropped). */
function workingMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const digits = raw.replace(/H$/, "");
  if (!/^\d{4}$/.test(digits)) return null;
  return Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
}

/** Minutes between two times of day, the short way round midnight. */
function clockGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/**
 * Pins each TRUST report of a run to the calling point it was made at: same STANOX (CORPUS, via
 * each TIPLOC), and — where a STANOX covers more than one point of the schedule, as a loop or a
 * station visited twice does — the one whose booked working time is closest to the report's
 * planned time. A later report for the same point and direction replaces an earlier one, so a
 * TRUST correction wins. Reports at a STANOX the schedule doesn't call at are left out: no
 * calling point is invented or moved (CLAUDE.md "do not silently repair source data").
 */
export function matchRunningToLocations(
  locations: readonly RunLocationTimes[],
  movements: readonly RunMovementRow[],
  stanoxByTiploc: ReadonlyMap<string, string>,
): Array<LocationRunning | null> {
  const result: Array<LocationRunning | null> = locations.map(() => null);
  const byStanox = new Map<string, number[]>();
  locations.forEach((loc, i) => {
    const stanox = stanoxByTiploc.get(loc.tiploc);
    if (!stanox) return;
    const list = byStanox.get(stanox) ?? [];
    list.push(i);
    byStanox.set(stanox, list);
  });

  const ordered = [...movements].sort((a, b) => a.created.getTime() - b.created.getTime());
  for (const movement of ordered) {
    if (!movement.loc_stanox || !movement.actual_timestamp) continue;
    const candidates = byStanox.get(movement.loc_stanox);
    if (!candidates) continue;
    const flags = decodeTrustMovementFlags(movement.flags);
    const slot: keyof LocationRunning | null =
      flags.eventKind === "departure"
        ? "departure"
        : flags.eventKind === "arrival" || flags.eventKind === "arrival_destination"
          ? "arrival"
          : null;
    if (!slot) continue;

    const planned = movement.planned_timestamp
      ? londonMinutesSinceMidnight(movement.planned_timestamp)
      : null;
    let best = candidates[0]!;
    if (planned !== null && candidates.length > 1) {
      let bestGap = Infinity;
      for (const i of candidates) {
        const loc = locations[i]!;
        const booked = workingMinutes(
          slot === "arrival" ? loc.arrivalWorking : (loc.departureWorking ?? loc.passWorking),
        );
        const gap = booked === null ? Infinity : clockGap(booked, planned);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      }
    }

    const entry = result[best] ?? { arrival: null, departure: null };
    entry[slot] = {
      actual: movement.actual_timestamp.toISOString(),
      minutesLate: signedVariationMinutes(movement.timetable_variation, flags.variation),
      platform: movement.platform,
    };
    result[best] = entry;
  }
  return result;
}
