import { delayBandForMinutesLate, type DelayBand } from "./delayBand.js";
import type { TrustMovementEventKind } from "./garnerMovement.js";

/**
 * Milestone 97b (docs/adr/0021): a lower bound on how late a held train is, while it stands in a
 * berth with nothing new from TRUST. Never lowers lateness, never extrapolates movement, and gives
 * way to TRUST the moment it reports again.
 *
 *  - rule 2, booked timing point: the train hasn't left a location it's booked to depart (or pass)
 *    at `bookedAt`, so it is at least `now − bookedAt` late;
 *  - rule 3, held in a plain berth: at least
 *    `last reported lateness + minutes held − berth allowance − allowances still ahead`,
 *    applied only when the run has a TRUST report and the berth isn't a booked stop.
 */
export interface HeldDelayInput {
  now: Date;
  occupancyEnteredAt: Date;
  /** The run's latest TRUST report, or null if it has none yet. */
  lastReport: {
    /** Signed minutes late (negative = early); null when TRUST gave no minutes. */
    minutesLate: number | null;
    /** When it happened (`actual_timestamp`). */
    actualAt: Date;
    kind: TrustMovementEventKind;
    terminated: boolean;
    /** Reported at this berth's own location (its STANOX is one of the berth's). */
    atThisBerthLocation: boolean;
  } | null;
  /** This berth's location in the train's schedule, for the visit it hasn't left yet. */
  timingPoint: {
    kind: "departure" | "pass";
    bookedAt: Date;
    /** The schedule's origin: the only place rule 2 applies before the run's first report. */
    atOrigin: boolean;
  } | null;
  /** The berth is at the schedule's destination. */
  atDestination: boolean;
  berthAllowanceMinutes: number;
  /** Booked allowances from the last reported location up to the next reporting point. */
  allowancesAheadMinutes: number;
  /** A whole-run cancellation, or a part-cancellation, is in force. */
  cancelled: boolean;
  /** The TD area has a feed gap covering the hold, so "stationary" may be missing steps. */
  feedGap: boolean;
  /** The same headcode has since appeared in another berth: likely a missed step. */
  seenElsewhere: boolean;
}

export type HeldDelayResult =
  | { kind: "estimate"; minutesLate: number; basis: "timing_point" | "held_in_berth" }
  /** Nothing worse than TRUST from this berth: an estimate already made for the run may stand. */
  | { kind: "none" }
  /** TRUST or a guard says the train moved, finished or was cancelled: any estimate ends. */
  | { kind: "blocked"; reason: HeldDelayBlockReason };

export type HeldDelayBlockReason =
  | "cancelled"
  | "feed_gap"
  | "seen_elsewhere"
  | "at_destination"
  | "terminated"
  | "reported_since_entry";

const MS_PER_MINUTE = 60_000;

export function estimateHeldDelay(input: HeldDelayInput): HeldDelayResult {
  if (input.cancelled) return { kind: "blocked", reason: "cancelled" };
  if (input.feedGap) return { kind: "blocked", reason: "feed_gap" };
  if (input.seenElsewhere) return { kind: "blocked", reason: "seen_elsewhere" };
  if (input.atDestination) return { kind: "blocked", reason: "at_destination" };
  const report = input.lastReport;
  if (report && (report.terminated || report.kind === "arrival_destination")) {
    return { kind: "blocked", reason: "terminated" };
  }
  // A report after the train entered this berth means TRUST has seen it move on — unless it's
  // the arrival at this berth's own station, which TRUST usually reports after the train has
  // stepped into the platform berth.
  if (
    report &&
    report.actualAt.getTime() > input.occupancyEnteredAt.getTime() &&
    !(report.atThisBerthLocation && report.kind === "arrival")
  ) {
    return { kind: "blocked", reason: "reported_since_entry" };
  }

  const reported = report?.minutesLate ?? null;
  const nowMs = input.now.getTime();
  const candidates: Array<{ minutes: number; basis: "timing_point" | "held_in_berth" }> = [];
  // Before its first TRUST report a run has only shown it exists at its origin. Mid-route, with
  // no report at all, nothing says the service ever started (production, 2026-10-26: 1S75 had no
  // reports since activation, yet its headcode sat in a Preston berth for over an hour).
  if (input.timingPoint && (report || input.timingPoint.atOrigin)) {
    candidates.push({
      minutes: (nowMs - input.timingPoint.bookedAt.getTime()) / MS_PER_MINUTE,
      basis: "timing_point",
    });
  }
  const bookedStop = input.timingPoint?.kind === "departure";
  if (report && reported !== null && !bookedStop) {
    const heldFrom = Math.max(input.occupancyEnteredAt.getTime(), report.actualAt.getTime());
    const held = (nowMs - heldFrom) / MS_PER_MINUTE;
    candidates.push({
      minutes: reported + held - input.berthAllowanceMinutes - input.allowancesAheadMinutes,
      basis: "held_in_berth",
    });
  }
  const best = candidates.reduce<(typeof candidates)[number] | null>(
    (worst, c) => (worst === null || c.minutes > worst.minutes ? c : worst),
    null,
  );
  if (!best) return { kind: "none" };
  const minutesLate = Math.floor(best.minutes);
  // Only ever worse than TRUST, and only once actually late.
  if (minutesLate <= 0 || (reported !== null && minutesLate <= reported)) return { kind: "none" };
  return { kind: "estimate", minutesLate, basis: best.basis };
}

/** A CIF allowance field (`"2"`, `"H"`, `"1H"`, blank) in minutes. Never throws: anything
 * unreadable counts as no allowance. */
export function parseCifAllowanceMinutes(raw: string | null | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  const match = /^(\d*)(H?)$/.exec(trimmed);
  if (!match || trimmed === "") return 0;
  return (match[1] ? Number(match[1]) : 0) + (match[2] ? 0.5 : 0);
}

/**
 * Which day after the traffic day a schedule time falls on. garner's `next_day` is set per
 * location from its first time only (a location arriving 23:59 and departing 00:01 has it false),
 * so a time more than six hours before the origin departure is also taken as the next day —
 * no train runs for 18 hours.
 */
export function scheduleDayOffset(
  minutes: number,
  originDepartureMinutes: number | null,
  nextDayFlag: boolean,
): number {
  if (nextDayFlag) return 1;
  if (originDepartureMinutes !== null && minutes < originDepartureMinutes - 360) return 1;
  return 0;
}

function londonOffsetMinutes(instantMs: number): number {
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(instantMs))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The instant of a London wall-clock time `minutes` after midnight on `dateStr` (`YYYY-MM-DD`)
 * plus `dayOffset` days. Calendar arithmetic only (ADR 0008): correct on a 23- or 25-hour
 * clock-change day. A time in the hour that repeats in October takes its first (BST) occurrence;
 * one in the March hour that doesn't exist is read an hour early (no train is booked in it).
 */
export function londonWallClockToInstant(dateStr: string, minutes: number, dayOffset = 0): Date {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(year, month - 1, day + dayOffset) + minutes * MS_PER_MINUTE;
  const firstGuess =
    wallAsUtc - londonOffsetMinutes(wallAsUtc - 60 * MS_PER_MINUTE) * MS_PER_MINUTE;
  const offset = londonOffsetMinutes(firstGuess);
  return new Date(wallAsUtc - offset * MS_PER_MINUTE);
}

/** A run's estimate in force, as the sweep last left it. */
export interface RunEstimateState {
  band: Exclude<DelayBand, "none">;
  minutesLate: number;
  basis: "timing_point" | "held_in_berth";
  /** The last time a berth actually produced this estimate (not merely carried it). */
  lastEstimatedAt: Date;
}

/** An estimate stops being carried after this long without a berth re-producing it. */
export const ESTIMATE_CARRY_LIMIT_MINUTES = 30;

export type RunEstimateChange =
  | { kind: "set"; state: RunEstimateState }
  | { kind: "cleared"; reason: HeldDelayBlockReason | "reported" | "carry_expired" };

/**
 * One sweep step for one run. An estimate is kept per run, not per berth: a train held 108
 * minutes at Lancaster stays red as it steps into the next berth, until TRUST reports again.
 *
 *  - a new estimate sets (or updates) the run's state; a change is recorded only when the band
 *    moves, so pushes stay rare;
 *  - "blocked" clears any estimate (TRUST has the train moving, finished or cancelled);
 *  - "none" carries an existing estimate, unless TRUST has reported since it was last produced,
 *    or it hasn't been produced for `ESTIMATE_CARRY_LIMIT_MINUTES`.
 *
 * `latestReportReceivedAt` is when the run's latest TRUST report arrived (`trust_movement.created`),
 * not when it happened, so a report that was simply delayed in transit still counts as new.
 */
export function nextRunEstimate(
  previous: RunEstimateState | null,
  result: HeldDelayResult,
  latestReportReceivedAt: Date | null,
  now: Date,
): { state: RunEstimateState | null; change: RunEstimateChange | null } {
  if (result.kind === "estimate") {
    const band = delayBandForMinutesLate(result.minutesLate) as Exclude<DelayBand, "none">;
    const state: RunEstimateState = {
      band,
      minutesLate: result.minutesLate,
      basis: result.basis,
      lastEstimatedAt: now,
    };
    return { state, change: previous?.band === band ? null : { kind: "set", state } };
  }
  if (!previous) return { state: null, change: null };
  if (result.kind === "blocked") {
    return { state: null, change: { kind: "cleared", reason: result.reason } };
  }
  if (latestReportReceivedAt && latestReportReceivedAt > previous.lastEstimatedAt) {
    return { state: null, change: { kind: "cleared", reason: "reported" } };
  }
  if (now.getTime() - previous.lastEstimatedAt.getTime() > ESTIMATE_CARRY_LIMIT_MINUTES * 60_000) {
    return { state: null, change: { kind: "cleared", reason: "carry_expired" } };
  }
  return { state: previous, change: null };
}
