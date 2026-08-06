/**
 * Milestone 7: pure mapping from a source-agnostic schedule record into the exact `schedule`/
 * `schedule_location` row shapes (migration `0013_schedule_tables.sql`). Shared by the
 * SCHEDULE full-file importer (`apps/worker/src/schedule/scheduleImporter.ts`) and the VSTP
 * projector (`apps/worker/src/vstp/projector.ts`) so there is exactly one place that knows how
 * a schedule record becomes rows, no matter which feed it came from — each caller only needs
 * to adapt its own raw wire shape (SCHEDULE's flatter `JsonScheduleV1`, VSTP's nested
 * XML-derived `CIF_bs`) into this one intermediate `ScheduleSourceRecord` shape first.
 */
export interface ScheduleSourceLocation {
  /** Raw location-type code from the source — SCHEDULE uses `LO`/`LI`/`LT`(+pass variants),
   * VSTP uses `OR`/`IP`/`TI` — normalized below rather than passed through raw, since the DB
   * column is a fixed enum regardless of which feed supplied the row. */
  locationType: string;
  tiploc: string;
  stanox?: string | null;
  arrivalPublic?: string | null;
  arrivalWorking?: string | null;
  departurePublic?: string | null;
  departureWorking?: string | null;
  passPublic?: string | null;
  passWorking?: string | null;
  platform?: string | null;
  path?: string | null;
  line?: string | null;
  activityCodes?: string[];
  rawActivityText?: string | null;
  dayOffset?: number;
}

export interface ScheduleSourceRecord {
  trainUid: string;
  scheduleStartDate: string;
  scheduleEndDate: string;
  stpIndicator: "C" | "N" | "O" | "P";
  daysRunsBitmask?: string | null;
  signallingId?: string | null;
  operatorCode?: string | null;
  trainServiceCode?: string | null;
  trainCategory?: string | null;
  trainStatus?: string | null;
  powerType?: string | null;
  locations: ScheduleSourceLocation[];
  source: "SCHEDULE" | "VSTP";
  rawSourceJson: unknown;
}

export interface ScheduleRowValues {
  trainUid: string;
  scheduleStartDate: string;
  scheduleEndDate: string;
  stpIndicator: "C" | "N" | "O" | "P";
  daysRunsBitmask: string | null;
  signallingId: string | null;
  operatorCode: string | null;
  trainServiceCode: string | null;
  trainCategory: string | null;
  trainStatus: string | null;
  powerType: string | null;
  originTiploc: string | null;
  destinationTiploc: string | null;
  source: "SCHEDULE" | "VSTP";
  rawSourceJson: unknown;
}

export type ScheduleLocationType = "origin" | "intermediate" | "pass" | "destination";

export interface ScheduleLocationRowValues {
  seqNo: number;
  locationType: ScheduleLocationType;
  tiploc: string;
  stanox: string | null;
  arrivalPublic: string | null;
  arrivalWorking: string | null;
  departurePublic: string | null;
  departureWorking: string | null;
  passPublic: string | null;
  passWorking: string | null;
  platform: string | null;
  path: string | null;
  line: string | null;
  activityCodes: string[];
  rawActivityText: string | null;
  dayOffset: number;
}

export interface MappedSchedule {
  schedule: ScheduleRowValues;
  locations: ScheduleLocationRowValues[];
}

function normalizeLocationType(raw: string, index: number, total: number): ScheduleLocationType {
  const upper = raw.toUpperCase();
  if (upper === "LO" || upper === "OR") return "origin";
  if (upper === "LT" || upper === "TI") return "destination";
  if (upper.startsWith("LP") || upper === "PP") return "pass";
  // Fall back to position for a code this mapping doesn't recognize yet — never guess wrong by
  // defaulting everything to "intermediate" when it's actually the first/last location.
  if (index === 0) return "origin";
  if (index === total - 1) return "destination";
  return "intermediate";
}

export function mapToScheduleRow(record: ScheduleSourceRecord): MappedSchedule {
  const locations: ScheduleLocationRowValues[] = record.locations.map((loc, index) => ({
    seqNo: index + 1,
    locationType: normalizeLocationType(loc.locationType, index, record.locations.length),
    tiploc: loc.tiploc,
    stanox: loc.stanox ?? null,
    arrivalPublic: loc.arrivalPublic ?? null,
    arrivalWorking: loc.arrivalWorking ?? null,
    departurePublic: loc.departurePublic ?? null,
    departureWorking: loc.departureWorking ?? null,
    passPublic: loc.passPublic ?? null,
    passWorking: loc.passWorking ?? null,
    platform: loc.platform ?? null,
    path: loc.path ?? null,
    line: loc.line ?? null,
    activityCodes: loc.activityCodes ?? [],
    rawActivityText: loc.rawActivityText ?? null,
    dayOffset: loc.dayOffset ?? 0,
  }));

  return {
    schedule: {
      trainUid: record.trainUid,
      scheduleStartDate: record.scheduleStartDate,
      scheduleEndDate: record.scheduleEndDate,
      stpIndicator: record.stpIndicator,
      daysRunsBitmask: record.daysRunsBitmask ?? null,
      signallingId: record.signallingId ?? null,
      operatorCode: record.operatorCode ?? null,
      trainServiceCode: record.trainServiceCode ?? null,
      trainCategory: record.trainCategory ?? null,
      trainStatus: record.trainStatus ?? null,
      powerType: record.powerType ?? null,
      originTiploc: locations[0]?.tiploc ?? null,
      destinationTiploc: locations.at(-1)?.tiploc ?? null,
      source: record.source,
      rawSourceJson: record.rawSourceJson,
    },
    locations,
  };
}
