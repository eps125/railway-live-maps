import {
  delayBandForMinutesLate,
  type DelayBand,
  type HeldDelayResult,
  type TrustMovementEventKind,
} from "@railway/domain";

/**
 * Milestone 97c (docs/adr/0021): the popup's delay line, shown to every visitor (owner,
 * 2026-10-26 — previously only logged-in users saw TRUST's minutes, and the public only a band).
 * `estimated` marks the held-train estimate, which can only ever be later than TRUST says.
 */
export interface PopupDelay {
  /** Signed minutes late (negative = early); null when nothing says how late. */
  minutesLate: number | null;
  band: DelayBand;
  estimated: boolean;
  /** Only when `estimated`: why, and since when the train has been standing. */
  estimate: {
    basis: "timing_point" | "held_in_berth";
    /** The estimate was made in an earlier berth and is being carried until TRUST reports. */
    carried: boolean;
    standingSince: string | null;
  } | null;
  lastReport: {
    minutesLate: number | null;
    eventKind: TrustMovementEventKind;
    locationName: string | null;
    at: string | null;
  } | null;
}

export interface PopupDelayInputs {
  lastReport: PopupDelay["lastReport"];
  /** The estimate worked out now for this berth (live popup only; null in playback). */
  live: HeldDelayResult | null;
  /** The estimate recorded for the run and in force at the moment asked about. */
  stored: {
    minutesLate: number;
    basis: "timing_point" | "held_in_berth";
    /** It was recorded for the berth being asked about (not carried from an earlier one). */
    sameOccupancy: boolean;
  } | null;
  standingSince: string | null;
}

export function popupDelay(inputs: PopupDelayInputs): PopupDelay | null {
  const { lastReport, live, stored, standingSince } = inputs;
  if (live?.kind === "estimate") {
    return {
      minutesLate: live.minutesLate,
      band: delayBandForMinutesLate(live.minutesLate),
      estimated: true,
      estimate: { basis: live.basis, carried: false, standingSince },
      lastReport,
    };
  }
  // A live "blocked" means TRUST (or a guard) has already overtaken any recorded estimate; the
  // sweep clears it on its next tick, so don't show it in the meantime.
  if (stored && live?.kind !== "blocked") {
    return {
      minutesLate: stored.minutesLate,
      band: delayBandForMinutesLate(stored.minutesLate),
      estimated: true,
      estimate: {
        basis: stored.basis,
        carried: !stored.sameOccupancy,
        standingSince: stored.sameOccupancy ? standingSince : null,
      },
      lastReport,
    };
  }
  if (!lastReport) return null;
  return {
    minutesLate: lastReport.minutesLate,
    band: delayBandForMinutesLate(lastReport.minutesLate),
    estimated: false,
    estimate: null,
    lastReport,
  };
}
