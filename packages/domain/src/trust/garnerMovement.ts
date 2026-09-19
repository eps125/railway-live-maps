/**
 * Decodes the `flags` integer that openrail-eps ("garner") packs each `trust_movement` row with
 * (garner `trustdb.c` `process_trust_0003`). RLM mirrors `trust_movement` near-verbatim (ADR
 * 0002, migration 0025), so this is the one place that knows garner's bit layout:
 *
 *   bits 0-1  event kind:  1 = departure, 2 = arrival, 3 = arrival at destination
 *   bit  2    event source was Manual (TOPS operator), not the automatic feed
 *   bits 3-4  variation status: 0 = EARLY, 1 = ON TIME, 2 = LATE, 3 = OFF ROUTE
 *   bit  5    off-route indicator set on the movement
 *   bit  6    train terminated at this location
 *   bit  7    correction (this report corrects a previous one)
 *
 * `timetable_variation` in the mirror is the unsigned magnitude in minutes garner stores; the
 * direction comes from the variation status here (EARLY => the train is that many minutes early).
 */

export type TrustMovementEventKind = "departure" | "arrival" | "arrival_destination" | "unknown";
export type TrustMovementVariation = "early" | "on_time" | "late" | "off_route";

export interface DecodedTrustMovementFlags {
  eventKind: TrustMovementEventKind;
  manual: boolean;
  variation: TrustMovementVariation;
  offRoute: boolean;
  terminated: boolean;
  correction: boolean;
}

const EVENT_KIND: Record<number, TrustMovementEventKind> = {
  1: "departure",
  2: "arrival",
  3: "arrival_destination",
};

const VARIATION: TrustMovementVariation[] = ["early", "on_time", "late", "off_route"];

export function decodeTrustMovementFlags(
  flags: number | null | undefined,
): DecodedTrustMovementFlags {
  const f = typeof flags === "number" && Number.isFinite(flags) ? flags : 0;
  return {
    eventKind: EVENT_KIND[f & 0x3] ?? "unknown",
    manual: (f & 0x4) !== 0,
    variation: VARIATION[(f >> 3) & 0x3] ?? "early",
    offRoute: (f & 0x20) !== 0,
    terminated: (f & 0x40) !== 0,
    correction: (f & 0x80) !== 0,
  };
}

/** Signed minutes late: positive = late, negative = early, 0 = on time / no data.
 * `off_route` carries no meaningful lateness, so it returns null. */
export function signedVariationMinutes(
  timetableVariation: number | null | undefined,
  variation: TrustMovementVariation,
): number | null {
  const magnitude =
    typeof timetableVariation === "number" && Number.isFinite(timetableVariation)
      ? Math.abs(timetableVariation)
      : 0;
  switch (variation) {
    case "late":
      return magnitude;
    case "early":
      return -magnitude;
    case "on_time":
      return 0;
    case "off_route":
      return null;
  }
}
