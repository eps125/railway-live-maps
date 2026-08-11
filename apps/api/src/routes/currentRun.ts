import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { TD_PROJECTION_VERSION, extractMovementReport } from "@railway/domain";
import { apiError } from "../lib/queryRange.js";
import { locationToJson, type LocationRow } from "./runs.js";

export interface CurrentRunRoutesDeps {
  pool: Pool;
}

interface CurrentStateRow {
  description: string | null;
  occupancy_id: string | null;
  occupancy_entered_at: Date | null;
}

interface ResolutionRow {
  status: "matched" | "ambiguous" | "unmatched";
  selected_train_run_id: string | null;
  confidence: string | null;
  resolver_version: number;
  decided_at: Date;
  candidates: unknown;
}

interface TrainRunRow {
  id: string;
  trust_train_id: string;
  signalling_id: string | null;
  service_date: string;
  schedule_id: string | null;
  activated_at: Date | null;
  operator_code: string | null;
  service_code: string | null;
  lifecycle_state: string;
}

interface RunScheduleLinkRow {
  match_outcome: string;
  schedule_id: string | null;
}

interface ScheduleRow {
  id: string;
  train_uid: string;
  stp_indicator: string;
  source: string;
  origin_tiploc: string | null;
  destination_tiploc: string | null;
}

/**
 * `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` (Milestone 9): the live map's
 * click-a-berth popup, one round trip — docs/PROJECT_SPEC.md §5's full field list (scheduled
 * origin/destination, booked times, operator, TRUST activation/TID, schedule UID/type, latest
 * TRUST report, match status/confidence/candidates). 404 (`BERTH_NOT_OCCUPIED`) for an empty
 * berth — matches "click a **populated** berth."
 */
export async function registerCurrentRunRoutes(
  app: FastifyInstance,
  deps: CurrentRunRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { tdArea: string; berth: string } }>(
    "/api/v1/td/areas/:tdArea/berths/:berth/current-run",
    async (request, reply) => {
      const { tdArea, berth } = request.params;

      const stateResult = await pool.query<CurrentStateRow>(
        `select description, occupancy_id, occupancy_entered_at
         from berth_current_state
         where projection_version = $1 and td_area = $2 and berth_code = $3`,
        [TD_PROJECTION_VERSION, tdArea, berth],
      );
      const state = stateResult.rows[0];
      if (!state || !state.occupancy_id) {
        reply.code(404);
        return apiError("BERTH_NOT_OCCUPIED", `${tdArea} ${berth} has no current occupancy`);
      }

      const resolutionResult = await pool.query<ResolutionRow>(
        `select status, selected_train_run_id, confidence, resolver_version, decided_at, candidates
         from berth_run_resolution where occupancy_id = $1`,
        [state.occupancy_id],
      );
      const resolution = resolutionResult.rows[0];

      let run: TrainRunRow | undefined;
      let scheduleLink: RunScheduleLinkRow | undefined;
      let schedule: ScheduleRow | undefined;
      let locations: LocationRow[] = [];
      let latestMovement: ReturnType<typeof extractMovementReport> | null = null;

      if (resolution?.selected_train_run_id) {
        const runResult = await pool.query<TrainRunRow>(
          `select id, trust_train_id, signalling_id, service_date::text as service_date,
                  schedule_id, activated_at, operator_code, service_code, lifecycle_state
           from train_run where id = $1`,
          [resolution.selected_train_run_id],
        );
        run = runResult.rows[0];

        const linkResult = await pool.query<RunScheduleLinkRow>(
          `select match_outcome, schedule_id from run_schedule_link where train_run_id = $1`,
          [resolution.selected_train_run_id],
        );
        scheduleLink = linkResult.rows[0];

        if (scheduleLink?.schedule_id) {
          const scheduleResult = await pool.query<ScheduleRow>(
            `select id, train_uid, stp_indicator, source, origin_tiploc, destination_tiploc
             from schedule where id = $1`,
            [scheduleLink.schedule_id],
          );
          schedule = scheduleResult.rows[0];

          const locationResult = await pool.query<LocationRow>(
            `select seq_no, location_type, tiploc, stanox, arrival_public, arrival_working,
                    departure_public, departure_working, pass_public, pass_working, platform,
                    path, line, activity_codes, day_offset
             from schedule_location where schedule_id = $1 order by seq_no`,
            [scheduleLink.schedule_id],
          );
          locations = locationResult.rows;
        }

        const movementResult = await pool.query<{ raw_event_json: unknown }>(
          `select raw_event_json from train_run_event
           where train_run_id = $1 and trust_message_type = 'movement'
           order by event_at desc limit 1`,
          [resolution.selected_train_run_id],
        );
        const movementRow = movementResult.rows[0];
        if (movementRow) {
          latestMovement = extractMovementReport(movementRow.raw_event_json);
        }
      }

      return {
        tdArea,
        berth,
        description: state.description,
        occupancyEnteredAt: state.occupancy_entered_at
          ? state.occupancy_entered_at.toISOString()
          : null,
        resolution: resolution
          ? {
              status: resolution.status,
              confidence: resolution.confidence !== null ? Number(resolution.confidence) : null,
              resolverVersion: resolution.resolver_version,
              decidedAt: resolution.decided_at.toISOString(),
              candidates: resolution.candidates,
            }
          : null,
        run: run
          ? {
              runId: run.id,
              trustTrainId: run.trust_train_id,
              signallingId: run.signalling_id,
              serviceDate: run.service_date,
              activatedAt: run.activated_at ? run.activated_at.toISOString() : null,
              operatorCode: run.operator_code,
              serviceCode: run.service_code,
              lifecycleState: run.lifecycle_state,
              scheduleLink: scheduleLink
                ? { matchOutcome: scheduleLink.match_outcome, scheduleId: scheduleLink.schedule_id }
                : null,
            }
          : null,
        schedule: schedule
          ? {
              scheduleId: schedule.id,
              trainUid: schedule.train_uid,
              stpIndicator: schedule.stp_indicator,
              source: schedule.source,
              originTiploc: schedule.origin_tiploc,
              destinationTiploc: schedule.destination_tiploc,
              locations: locations.map(locationToJson),
            }
          : null,
        latestMovement,
      };
    },
  );
}
