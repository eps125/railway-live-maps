/**
 * Milestone 9: extracts the "latest TRUST report" fields docs/PROJECT_SPEC.md §5 asks for
 * (event type, location, timetable variation) from a `train_run_event` row's raw JSON, and
 * builds the short Vail-like running-indication string ("approximately 1 late") the same spec
 * section allows — "only when it is clearly derived from the latest TRUST report," never a
 * prediction. `raw_event_json` is the full `{header, body}` shape
 * apps/worker/src/trust/projector.ts stores (see its own `row.raw_event_json.body` read) — the
 * movement fields live on `body`. Field names/values are the real ones
 * packages/feed-parsers/fixtures/trust/movement-*.json use.
 */
export interface MovementReport {
  eventType: string | null;
  locationStanox: string | null;
  platform: string | null;
  variationStatus: "EARLY" | "LATE" | "ON TIME" | "OFF ROUTE" | null;
  timetableVariationMinutes: number | null;
}

const KNOWN_VARIATION_STATUSES = new Set(["EARLY", "LATE", "ON TIME", "OFF ROUTE"]);

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function extractMovementReport(rawEventJson: unknown): MovementReport {
  const body = (rawEventJson as { body?: Record<string, unknown> } | null)?.body ?? {};
  const variationStatusRaw = stringField(body, "variation_status");
  const variationStatus =
    variationStatusRaw && KNOWN_VARIATION_STATUSES.has(variationStatusRaw)
      ? (variationStatusRaw as MovementReport["variationStatus"])
      : null;
  const timetableVariationRaw = stringField(body, "timetable_variation");
  const timetableVariationMinutes =
    timetableVariationRaw !== null && /^\d+$/.test(timetableVariationRaw)
      ? Number(timetableVariationRaw)
      : null;

  return {
    eventType: stringField(body, "event_type"),
    locationStanox: stringField(body, "loc_stanox"),
    platform: stringField(body, "platform"),
    variationStatus,
    timetableVariationMinutes,
  };
}

export function runningIndicationText(report: MovementReport): string | null {
  if (report.variationStatus === "ON TIME") return "on time";
  if (report.variationStatus === "OFF ROUTE") return "off route";
  if (report.timetableVariationMinutes === null) return null;
  if (report.variationStatus === "EARLY")
    return `approximately ${report.timetableVariationMinutes} early`;
  if (report.variationStatus === "LATE")
    return `approximately ${report.timetableVariationMinutes} late`;
  return null;
}
