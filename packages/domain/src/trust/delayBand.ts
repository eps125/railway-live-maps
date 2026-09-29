import { decodeTrustMovementFlags, signedVariationMinutes } from "./garnerMovement.js";

/**
 * Milestone 82 (owner request 2026-09-29): the coarse lateness band the public map can colour a
 * berth by, taken from the train's **latest TRUST report** as reported — never a prediction and
 * never extrapolated from where the train is now.
 *
 *   none      no information: no report, off route, or a late/early report with no minutes
 *   on_time   on time, early, or under 15 minutes late (owner revision 2026-09-29: its own
 *             band, drawn green, rather than sharing blue with "no information")
 *   minor     15-29 minutes late
 *   moderate  30-59 minutes late
 *   severe    60 or more minutes late
 *
 * Only the band leaves the API, not the minutes: the owner cleared a coarse band for anonymous
 * visitors, and the exact variation stays in the (logged-in) popup detail.
 */
export type DelayBand = "none" | "on_time" | "minor" | "moderate" | "severe";

/** `minutesLate` is signed (negative = early); `null` means nothing is known. */
export function delayBandForMinutesLate(minutesLate: number | null): DelayBand {
  if (minutesLate === null) return "none";
  if (minutesLate < 15) return "on_time";
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
  // A late or early report without its minutes says nothing about how late — don't read the
  // missing value as zero (which `signedVariationMinutes` does) and call it on time.
  const hasMinutes = typeof timetableVariation === "number" && Number.isFinite(timetableVariation);
  if (!hasMinutes && (variation === "late" || variation === "early")) return "none";
  return delayBandForMinutesLate(signedVariationMinutes(timetableVariation, variation));
}
