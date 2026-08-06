import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { selectEffectiveSchedule, type ScheduleCandidate } from "@railway/domain";
import { apiError } from "../lib/queryRange.js";

export interface ScheduleRoutesDeps {
  pool: Pool;
}

interface ScheduleRow {
  id: string;
  train_uid: string;
  // Cast to text in SQL below — node-postgres parses `date` columns into a Date constructed in
  // the server's local timezone, which silently shifts a single-day range by a day whenever the
  // process timezone isn't UTC. Casting sidesteps that entirely: Postgres's `date` type has no
  // timezone of its own, so `::text` always yields the exact stored YYYY-MM-DD.
  schedule_start_date: string;
  schedule_end_date: string;
  stp_indicator: "C" | "N" | "O" | "P";
  days_runs_bitmask: string | null;
  signalling_id: string | null;
  operator_code: string | null;
  train_service_code: string | null;
  train_category: string | null;
  train_status: string | null;
  power_type: string | null;
  origin_tiploc: string | null;
  destination_tiploc: string | null;
  source: "SCHEDULE" | "VSTP";
}

interface LocationRow {
  seq_no: number;
  location_type: string;
  tiploc: string;
  stanox: string | null;
  arrival_public: string | null;
  arrival_working: string | null;
  departure_public: string | null;
  departure_working: string | null;
  pass_public: string | null;
  pass_working: string | null;
  platform: string | null;
  path: string | null;
  line: string | null;
  activity_codes: string[];
  day_offset: number;
}

function scheduleToJson(row: ScheduleRow) {
  return {
    trainUid: row.train_uid,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    stpIndicator: row.stp_indicator,
    daysRunsBitmask: row.days_runs_bitmask,
    signallingId: row.signalling_id,
    operatorCode: row.operator_code,
    trainServiceCode: row.train_service_code,
    trainCategory: row.train_category,
    trainStatus: row.train_status,
    powerType: row.power_type,
    originTiploc: row.origin_tiploc,
    destinationTiploc: row.destination_tiploc,
    source: row.source,
  };
}

function locationToJson(row: LocationRow) {
  return {
    seqNo: row.seq_no,
    locationType: row.location_type,
    tiploc: row.tiploc,
    stanox: row.stanox,
    arrivalPublic: row.arrival_public,
    arrivalWorking: row.arrival_working,
    departurePublic: row.departure_public,
    departureWorking: row.departure_working,
    passPublic: row.pass_public,
    passWorking: row.pass_working,
    platform: row.platform,
    path: row.path,
    line: row.line,
    activityCodes: row.activity_codes,
    dayOffset: row.day_offset,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `GET /api/v1/schedule/{trainUid}?date=YYYY-MM-DD` (docs/API_CONTRACT.md, Milestone 7).
 * Resolves the STP-effective schedule for a train_uid on a given traffic day via
 * `resolveStpPrecedence` (CLAUDE.md rule 7: resolver results must be `matched`, `ambiguous` or
 * `unmatched` — this endpoint always returns one of exactly those three `outcome` values,
 * never silently picking a candidate or omitting ambiguity).
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

      const result = await pool.query<ScheduleRow>(
        `select id, train_uid, schedule_start_date::text as schedule_start_date,
                schedule_end_date::text as schedule_end_date, stp_indicator,
                days_runs_bitmask, signalling_id, operator_code, train_service_code,
                train_category, train_status, power_type, origin_tiploc, destination_tiploc, source
         from schedule
         where train_uid = $1`,
        [trainUid],
      );

      if (result.rows.length === 0) {
        reply.code(404);
        return apiError("SCHEDULE_NOT_FOUND", `no schedule found for train_uid ${trainUid}`);
      }

      const candidates: (ScheduleCandidate & { row: ScheduleRow })[] = result.rows.map((row) => ({
        stpIndicator: row.stp_indicator,
        scheduleStartDate: row.schedule_start_date,
        scheduleEndDate: row.schedule_end_date,
        daysRunsBitmask: row.days_runs_bitmask,
        row,
      }));

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
      const locations = await pool.query<LocationRow>(
        `select seq_no, location_type, tiploc, stanox, arrival_public, arrival_working,
                departure_public, departure_working, pass_public, pass_working, platform, path,
                line, activity_codes, day_offset
         from schedule_location
         where schedule_id = $1
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
