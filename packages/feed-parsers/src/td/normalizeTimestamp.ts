export interface NormalizeTimestampResult {
  normalizedEventAtUtc: string;
  correctionCode: "none" | "unparseable" | "implausible_skew";
  correctionDetails: string | null;
}

/** docs/DATA_MODEL.md §2: "TD has rare timestamp anomalies around midnight" — the exact
 * threshold isn't specified anywhere in the docs; this is a documented placeholder pending
 * confirmation against real Milestone 0 captured fixtures, not an invented precise rule. */
const PLAUSIBILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * raw_feed_event.normalized_event_at_utc is NOT NULL (required by the partitioned primary
 * key). When the source timestamp can't be trusted, this falls back to `receivedAt` and
 * records why via correctionCode/correctionDetails — never silently drops or guesses.
 */
export function normalizeTimestamp(
  rawText: string | null,
  receivedAt: Date,
): NormalizeTimestampResult {
  if (rawText === null) {
    return {
      normalizedEventAtUtc: receivedAt.toISOString(),
      correctionCode: "unparseable",
      correctionDetails: "no source timestamp present",
    };
  }

  const ms = Number(rawText);
  if (!Number.isFinite(ms) || ms <= 0) {
    return {
      normalizedEventAtUtc: receivedAt.toISOString(),
      correctionCode: "unparseable",
      correctionDetails: `could not parse "${rawText}" as an epoch-ms timestamp`,
    };
  }

  const parsed = new Date(ms);
  const skewMs = Math.abs(parsed.getTime() - receivedAt.getTime());
  if (skewMs > PLAUSIBILITY_WINDOW_MS) {
    return {
      normalizedEventAtUtc: receivedAt.toISOString(),
      correctionCode: "implausible_skew",
      correctionDetails: `source timestamp ${parsed.toISOString()} is ${skewMs}ms from received_at; substituted received_at`,
    };
  }

  return {
    normalizedEventAtUtc: parsed.toISOString(),
    correctionCode: "none",
    correctionDetails: null,
  };
}
