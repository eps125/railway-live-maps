import { decodeTrustMovementFlags, signedVariationMinutes } from "./garnerMovement.js";

/**
 * Milestone 82 (owner request 2026-09-29): the coarse lateness band the public map can colour a
 * berth by, taken from the train's **latest TRUST report** as reported — never a prediction and
 * never extrapolated from where the train is now.
 *
 *   none      no report, early, on time, off route, or under 15 minutes late
 *   minor     15-29 minutes late
 *   moderate  30-59 minutes late
 *   severe    60 or more minutes late
 *
 * Only the band leaves the API, not the minutes: the owner cleared a coarse band for anonymous
 * visitors, and the exact variation stays in the (logged-in) popup detail.
 */
export type DelayBand = "none" | "minor" | "moderate" | "severe";

export function delayBandForMinutesLate(minutesLate: number | null): DelayBand {
  if (minutesLate === null || minutesLate < 15) return "none";
  if (minutesLate < 30) return "minor";
  if (minutesLate < 60) return "moderate";
  return "severe";
}

/** The band for one mirrored `trust_movement` row (`timetable_variation` + garner's `flags`). */
export function delayBandForMovement(
  timetableVariation: number | null | undefined,
  flags: number | null | undefined,
): DelayBand {
  const { variation } = decodeTrustMovementFlags(flags);
  return delayBandForMinutesLate(signedVariationMinutes(timetableVariation, variation));
}
