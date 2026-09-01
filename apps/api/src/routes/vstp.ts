import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { parseLimit } from "../lib/queryRange.js";

export interface VstpRoutesDeps {
  pool: Pool;
}

/**
 * Since ADR 0002 (2026-09-01) there is no separate RLM VSTP store — short-term-planning schedule
 * changes live in the garner `cif_schedules` mirror (migration 0024) alongside the permanent
 * WTT, distinguished by `cif_stp_indicator` (`O` overlay / `N` new / `C` cancel, vs `P`
 * permanent). This endpoint surfaces those non-permanent rows, most-recent first.
 */
interface StpScheduleRow {
  id: string;
  cif_train_uid: string;
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
  created: Date;
}

function stpScheduleToJson(row: StpScheduleRow) {
  return {
    id: row.id,
    trainUid: row.cif_train_uid,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    stpIndicator: row.cif_stp_indicator,
    daysRunsBitmask: row.days_runs_bitmask,
    signallingId: row.signalling_id,
    operatorCode: row.atoc_code,
    trainServiceCode: row.cif_train_service_code,
    trainCategory: row.cif_train_category,
    trainStatus: row.train_status,
    powerType: row.cif_power_type,
    originTiploc: row.origin_tiploc,
    destinationTiploc: row.destination_tiploc,
    createdAt: row.created.toISOString(),
  };
}

/**
 * `GET /api/v1/vstp/schedules?atocCode=&before=&limit=` — nationwide short-term-planning schedule
 * discovery, mirroring what `/api/v1/td/areas` gives TD (docs/API_CONTRACT.md §1). Ordered
 * `id desc` (most recent first); `before` pages backward in time.
 */
export async function registerVstpRoutes(
  app: FastifyInstance,
  deps: VstpRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Querystring: { atocCode?: string; before?: string; limit?: string } }>(
    "/api/v1/vstp/schedules",
    async (request, reply) => {
      const { atocCode, before } = request.query;
      const limit = parseLimit(request.query.limit);

      const conditions = ["s.cif_stp_indicator <> 'P'", "s.deleted is null"];
      const values: unknown[] = [];
      if (atocCode) {
        values.push(atocCode);
        conditions.push(`s.atoc_code = $${values.length}`);
      }
      if (before) {
        values.push(before);
        conditions.push(`s.id < $${values.length}`);
      }
      values.push(limit);

      const result = await pool.query<StpScheduleRow>(
        `select s.id, s.cif_train_uid,
                s.schedule_start_date::text as schedule_start_date,
                s.schedule_end_date::text as schedule_end_date,
                s.cif_stp_indicator, s.days_runs_bitmask, s.signalling_id, s.atoc_code,
                s.cif_train_service_code, s.cif_train_category, s.train_status, s.cif_power_type,
                s.created,
                (select l.tiploc_code from cif_schedule_locations l
                  where l.cif_schedule_id = s.id order by l.seq_no asc limit 1) as origin_tiploc,
                (select l.tiploc_code from cif_schedule_locations l
                  where l.cif_schedule_id = s.id order by l.seq_no desc limit 1) as destination_tiploc
         from cif_schedules s
         where ${conditions.join(" and ")}
         order by s.id desc
         limit $${values.length}`,
        values,
      );

      const schedules = result.rows.map(stpScheduleToJson);
      const last = schedules.at(-1);

      reply.send({
        schedules,
        nextCursor: schedules.length === limit && last ? last.id : null,
      });
    },
  );
}
