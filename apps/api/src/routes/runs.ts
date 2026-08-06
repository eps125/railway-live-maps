import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError } from "../lib/queryRange.js";

export interface RunRoutesDeps {
  pool: Pool;
}

interface TrainRunRow {
  id: string;
  trust_train_id: string;
  signalling_id: string | null;
  service_date: string;
  schedule_id: string | null;
  activated_at: Date | null;
  origin_departure_at: Date | null;
  call_type: string | null;
  call_mode: string | null;
  operator_code: string | null;
  service_code: string | null;
  lifecycle_state: string;
  superseded_by_train_run_id: string | null;
  last_event_at: Date;
}

interface RunScheduleLinkRow {
  match_outcome: string;
  schedule_id: string | null;
  resolved_at: Date;
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

/**
 * `GET /api/v1/runs/{runId}` / `GET /api/v1/runs/{runId}/schedule`
 * (docs/API_CONTRACT.md, Milestone 8). `resolverEvidence` is always `null` here — the berth-run
 * resolver is Milestone 9 and hasn't populated `berth_run_resolution` yet; this field is
 * present now so the response shape doesn't change once M9 lands.
 */
export async function registerRunRoutes(app: FastifyInstance, deps: RunRoutesDeps): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) => {
    const { runId } = request.params;

    const runResult = await pool.query<TrainRunRow>(
      `select id, trust_train_id, signalling_id, service_date::text as service_date, schedule_id,
              activated_at, origin_departure_at, call_type, call_mode, operator_code, service_code,
              lifecycle_state, superseded_by_train_run_id, last_event_at
       from train_run where id = $1`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) {
      reply.code(404);
      return apiError("RUN_NOT_FOUND", `no run found for runId ${runId}`);
    }

    const linkResult = await pool.query<RunScheduleLinkRow>(
      `select match_outcome, schedule_id, resolved_at from run_schedule_link where train_run_id = $1`,
      [runId],
    );
    const link = linkResult.rows[0];

    return {
      runId: run.id,
      trustTrainId: run.trust_train_id,
      signallingId: run.signalling_id,
      serviceDate: run.service_date,
      scheduleId: run.schedule_id,
      activatedAt: run.activated_at ? run.activated_at.toISOString() : null,
      originDepartureAt: run.origin_departure_at ? run.origin_departure_at.toISOString() : null,
      callType: run.call_type,
      callMode: run.call_mode,
      operatorCode: run.operator_code,
      serviceCode: run.service_code,
      lifecycleState: run.lifecycle_state,
      supersededByTrainRunId: run.superseded_by_train_run_id,
      lastEventAt: run.last_event_at.toISOString(),
      scheduleLink: link
        ? {
            matchOutcome: link.match_outcome,
            scheduleId: link.schedule_id,
            resolvedAt: link.resolved_at.toISOString(),
          }
        : null,
      resolverEvidence: null,
    };
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/schedule", async (request, reply) => {
    const { runId } = request.params;

    const runResult = await pool.query<{ schedule_id: string | null }>(
      `select schedule_id from train_run where id = $1`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) {
      reply.code(404);
      return apiError("RUN_NOT_FOUND", `no run found for runId ${runId}`);
    }
    if (!run.schedule_id) {
      reply.code(404);
      return apiError("RUN_SCHEDULE_NOT_LINKED", `run ${runId} has no linked schedule`);
    }

    const locations = await pool.query<LocationRow>(
      `select seq_no, location_type, tiploc, stanox, arrival_public, arrival_working,
                departure_public, departure_working, pass_public, pass_working, platform, path,
                line, activity_codes, day_offset
         from schedule_location
         where schedule_id = $1
         order by seq_no`,
      [run.schedule_id],
    );

    return { locations: locations.rows.map(locationToJson) };
  });
}
