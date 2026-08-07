import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { parseLimit } from "../lib/queryRange.js";

export interface VstpRoutesDeps {
  pool: Pool;
}

interface VstpScheduleRow {
  id: string;
  train_uid: string;
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
  created_at: Date;
}

function vstpScheduleToJson(row: VstpScheduleRow) {
  return {
    id: row.id,
    trainUid: row.train_uid,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    stpIndicator: row.stp_indicator,
    daysRunsBitmask: row.days_runs_bitmask,
    signallingId: row.signalling_id,
    // "ATOC code" (the query param and NR's own CIF/VSTP field name) and this API's existing
    // `operatorCode` (see routes/schedule.ts) are the same value — apps/worker/src/vstp/
    // projector.ts populates the operator_code column directly from the BS record's atoc_code
    // field. Kept as `operatorCode` here for consistency with GET /api/v1/schedule/:trainUid.
    operatorCode: row.operator_code,
    trainServiceCode: row.train_service_code,
    trainCategory: row.train_category,
    trainStatus: row.train_status,
    powerType: row.power_type,
    originTiploc: row.origin_tiploc,
    destinationTiploc: row.destination_tiploc,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * `GET /api/v1/vstp/schedules` — nationwide VSTP discovery, mirroring what
 * `/api/v1/td/areas`/`/api/v1/td/areas/{area}/berths` give TD (docs/API_CONTRACT.md §1's
 * "map-authoring and diagnostics" intent, extended to VSTP): browse everything captured, not
 * just a single known train_uid the way `GET /api/v1/schedule/:trainUid` requires. Backed by
 * nationwide ingestion, never a configured allow-list.
 *
 * Ordered most-recent-first (`id desc`) since the point of this endpoint is "what's come in
 * recently", not exhaustive enumeration — `nextCursor`/`before` page backward in time from
 * there, the opposite direction of the `after`-based cursors elsewhere in this API.
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

      const conditions = ["source = 'VSTP'"];
      const values: unknown[] = [];
      if (atocCode) {
        values.push(atocCode);
        conditions.push(`operator_code = $${values.length}`);
      }
      if (before) {
        values.push(before);
        conditions.push(`id < $${values.length}`);
      }
      values.push(limit);

      const result = await pool.query<VstpScheduleRow>(
        `select id, train_uid, schedule_start_date::text as schedule_start_date,
                schedule_end_date::text as schedule_end_date, stp_indicator,
                days_runs_bitmask, signalling_id, operator_code, train_service_code,
                train_category, train_status, power_type, origin_tiploc, destination_tiploc,
                created_at
         from schedule
         where ${conditions.join(" and ")}
         order by id desc
         limit $${values.length}`,
        values,
      );

      const schedules = result.rows.map(vstpScheduleToJson);
      const last = schedules.at(-1);

      reply.send({
        schedules,
        nextCursor: schedules.length === limit && last ? last.id : null,
      });
    },
  );
}
