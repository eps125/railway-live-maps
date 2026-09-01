import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { selectEffectiveSchedule, type ScheduleCandidate } from "@railway/domain";
import { apiError } from "../lib/queryRange.js";

export interface ScheduleRoutesDeps {
  pool: Pool;
}

/**
 * Since ADR 0002 (2026-09-01) RLM mirrors the operator's openrail-eps ("garner")
 * `cif_schedules` / `cif_schedule_locations` near-verbatim (migration 0024) instead of running
 * its own SCHEDULE/VSTP importer. These routes read that mirror. `source` is always `GARNER`.
 */
interface CifScheduleRow {
  id: string;
  cif_train_uid: string;
  // Cast to text in SQL — node-postgres parses `date` into a Date in the process timezone,
  // which can shift a single-day range by a day. Postgres `date` has no timezone; `::text`
  // yields the exact stored YYYY-MM-DD.
  schedule_start_date: string;
  schedule_end_date: string;
  cif_stp_indicator: string;
  days_runs_bitmask: string | null;
  signalling_id: string | null;
  atoc_code: string | null;
  cif_train_service_code: string | null;
  cif_train_category: string | null;
  train_status: string | null;
  cif_power_type: string | null;
  origin_tiploc: string | null;
  destination_tiploc: string | null;
}

export interface CifLocationRowLike {
  seq_no: number;
  record_identity: string;
  location_type: string | null;
  tiploc_code: string;
  arrival: string | null;
  departure: string | null;
  pass: string | null;
  public_arrival: string | null;
  public_departure: string | null;
  platform: string | null;
  path: string | null;
  line: string | null;
  next_day: boolean;
}

const STP: ReadonlySet<string> = new Set(["C", "N", "O", "P"]);
function normalizeStp(value: string): "C" | "N" | "O" | "P" {
  return STP.has(value) ? (value as "C" | "N" | "O" | "P") : "P";
}

/** garner's misnamed `cif_schedule_locations.location_type` holds the CIF activity field: up to
 * six packed 2-char codes. Split it back into a list, dropping blanks. */
export function parseCifActivity(value: string | null): string[] {
  if (!value) return [];
  const codes: string[] = [];
  for (let i = 0; i < value.length; i += 2) {
    const code = value.slice(i, i + 2).trim();
    if (code) codes.push(code);
  }
  return codes;
}

/** LO -> origin, LT -> destination, LI with only a pass time -> pass, else intermediate. */
export function locationTypeFor(
  row: CifLocationRowLike,
): "origin" | "intermediate" | "pass" | "destination" {
  if (row.record_identity === "LO") return "origin";
  if (row.record_identity === "LT") return "destination";
  const hasCall = row.arrival !== null || row.departure !== null;
  return !hasCall && row.pass !== null ? "pass" : "intermediate";
}

export function scheduleToJson(row: CifScheduleRow) {
  return {
    scheduleId: row.id,
    trainUid: row.cif_train_uid,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    stpIndicator: normalizeStp(row.cif_stp_indicator),
    daysRunsBitmask: row.days_runs_bitmask,
    signallingId: row.signalling_id,
    operatorCode: row.atoc_code,
    trainServiceCode: row.cif_train_service_code,
    trainCategory: row.cif_train_category,
    trainStatus: row.train_status,
    powerType: row.cif_power_type,
    originTiploc: row.origin_tiploc,
    destinationTiploc: row.destination_tiploc,
    source: "GARNER" as const,
  };
}

export function locationToJson(row: CifLocationRowLike) {
  return {
    seqNo: row.seq_no,
    recordIdentity: row.record_identity,
    locationType: locationTypeFor(row),
    tiploc: row.tiploc_code,
    stanox: null,
    arrivalPublic: row.public_arrival,
    arrivalWorking: row.arrival,
    departurePublic: row.public_departure,
    departureWorking: row.departure,
    passPublic: null,
    passWorking: row.pass,
    platform: row.platform,
    path: row.path,
    line: row.line,
    activityCodes: parseCifActivity(row.location_type),
    dayOffset: row.next_day ? 1 : 0,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SCHEDULE_SELECT = `select s.id, s.cif_train_uid,
        s.schedule_start_date::text as schedule_start_date,
        s.schedule_end_date::text as schedule_end_date,
        s.cif_stp_indicator, s.days_runs_bitmask, s.signalling_id, s.atoc_code,
        s.cif_train_service_code, s.cif_train_category, s.train_status, s.cif_power_type,
        (select l.tiploc_code from cif_schedule_locations l
          where l.cif_schedule_id = s.id order by l.seq_no asc limit 1) as origin_tiploc,
        (select l.tiploc_code from cif_schedule_locations l
          where l.cif_schedule_id = s.id order by l.seq_no desc limit 1) as destination_tiploc
   from cif_schedules s`;

/**
 * `GET /api/v1/schedule/{trainUid}?date=YYYY-MM-DD` (docs/API_CONTRACT.md). Resolves the
 * STP-effective schedule for a train_uid on a given traffic day via `selectEffectiveSchedule`
 * (CLAUDE.md rule 7: the `outcome` is always exactly `matched`/`ambiguous`/`unmatched`, never a
 * silent pick).
 */
export async function registerScheduleRoutes(
  app: FastifyInstance,
  deps: ScheduleRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { trainUid: string }; Querystring: { date?: string } }>(
    "/api/v1/schedule/:trainUid",
    async (request, reply) => {
      const { trainUid } = request.params;
      const { date } = request.query;

      if (!date || !DATE_RE.test(date)) {
        reply.code(400);
        return apiError("INVALID_DATE", "date must be supplied as YYYY-MM-DD");
      }

      const result = await pool.query<CifScheduleRow>(
        `${SCHEDULE_SELECT} where s.cif_train_uid = $1 and s.deleted is null`,
        [trainUid],
      );

      if (result.rows.length === 0) {
        reply.code(404);
        return apiError("SCHEDULE_NOT_FOUND", `no schedule found for train_uid ${trainUid}`);
      }

      const candidates: (ScheduleCandidate & { row: CifScheduleRow })[] = result.rows.map(
        (row) => ({
          stpIndicator: normalizeStp(row.cif_stp_indicator),
          scheduleStartDate: row.schedule_start_date,
          scheduleEndDate: row.schedule_end_date,
          daysRunsBitmask: row.days_runs_bitmask,
          row,
        }),
      );

      const outcome = selectEffectiveSchedule(candidates, date);

      if (outcome.outcome === "none") {
        reply.code(404);
        return { outcome: "unmatched" };
      }

      if (outcome.outcome === "ambiguous") {
        return {
          outcome: "ambiguous",
          candidates: outcome.candidates.map((c) => scheduleToJson(c.row)),
        };
      }

      const selectedRow = outcome.selected.row;
      const locations = await pool.query<CifLocationRowLike>(
        `select seq_no, record_identity, location_type, tiploc_code, arrival, departure, "pass",
                public_arrival, public_departure, platform, path, line, next_day
         from cif_schedule_locations
         where cif_schedule_id = $1
         order by seq_no`,
        [selectedRow.id],
      );

      return {
        outcome: "matched",
        schedule: scheduleToJson(selectedRow),
        locations: locations.rows.map(locationToJson),
      };
    },
  );
}
