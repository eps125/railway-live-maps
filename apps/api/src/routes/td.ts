import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { parseLimit, parseTimeRange } from "../lib/queryRange.js";

export interface TdRoutesDeps {
  pool: Pool;
}

interface AreaSummaryRow {
  td_area: string;
  first_event_at: Date;
  last_event_at: Date;
  c_class_count: string;
  s_class_count: string;
}

interface HeartbeatRow {
  td_area: string;
  last_heartbeat_at: Date;
}

interface BerthActivityRow {
  berth_code: string;
  first_observed_at: Date;
  last_observed_at: Date;
  event_count: string;
}

interface OccupancyIntervalRow {
  id: string;
  td_area?: string;
  berth_code?: string;
  entered_at: Date;
  left_at: Date | null;
  description: string;
  entry_reason: string;
  exit_reason: string | null;
  // Left-joined from berth_run_resolution (migration 0022 dropped the denormalized copy that
  // used to live directly on berth_occupancy) — null means no resolution attempt has been
  // recorded for this occupancy yet, distinct from an attempt that came back 'unmatched'.
  resolution_status: string | null;
  anomaly_flags: string[];
}

interface SClassEventRow {
  id: string;
  message_type: string;
  address: string | null;
  raw_value: string | null;
  decode_status: string;
  event_at: Date;
  ingestion_sequence: string;
}

function occupancyToJson(row: OccupancyIntervalRow) {
  return {
    ...(row.td_area !== undefined ? { tdArea: row.td_area } : {}),
    ...(row.berth_code !== undefined ? { berthCode: row.berth_code } : {}),
    enteredAt: row.entered_at.toISOString(),
    leftAt: row.left_at ? row.left_at.toISOString() : null,
    durationMs: row.left_at ? row.left_at.getTime() - row.entered_at.getTime() : null,
    description: row.description,
    entryReason: row.entry_reason,
    exitReason: row.exit_reason,
    resolutionStatus: row.resolution_status,
    anomalyFlags: row.anomaly_flags,
  };
}

/** Nationwide TD area/berth discovery + history endpoints (docs/IMPLEMENTATION_PLAN.md
 * Milestone 4, docs/API_CONTRACT.md §1). Backed by nationwide ingestion — never a configured
 * allow-list — so every observed area/berth appears regardless of map coverage. */
export async function registerTdRoutes(app: FastifyInstance, deps: TdRoutesDeps): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/td/areas", async () => {
    const [areas, heartbeats] = await Promise.all([
      // Reads the rollup td_area_summary (migration 0023) maintained incrementally by
      // project-td, not a live `group by td_area` scan of raw_feed_event — that scan took 11+
      // minutes once the table reached tens of millions of nationwide rows (production incident,
      // 2026-09-01).
      pool.query<AreaSummaryRow>(
        `select td_area, first_event_at, last_event_at, c_class_count, s_class_count
         from td_area_summary
         order by td_area`,
      ),
      pool.query<HeartbeatRow>(
        `select td_area, max(event_at) as last_heartbeat_at from td_heartbeat group by td_area`,
      ),
    ]);

    const lastHeartbeatByArea = new Map(
      heartbeats.rows.map((row) => [row.td_area, row.last_heartbeat_at]),
    );

    return {
      areas: areas.rows.map((row) => ({
        tdArea: row.td_area,
        firstEventAt: row.first_event_at.toISOString(),
        lastEventAt: row.last_event_at.toISOString(),
        cClassCount: Number(row.c_class_count),
        sClassCount: Number(row.s_class_count),
        lastHeartbeatAt: lastHeartbeatByArea.get(row.td_area)?.toISOString() ?? null,
      })),
    };
  });

  app.get<{ Params: { area: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/v1/td/areas/:area/berths",
    async (request, reply) => {
      const { area } = request.params;
      const limit = parseLimit(request.query.limit);
      const after = request.query.after ?? "";

      const result = await pool.query<BerthActivityRow>(
        `select berth_code, min(observed_at) as first_observed_at, max(observed_at) as last_observed_at,
                count(*) as event_count
         from (
           select from_berth as berth_code, event_at as observed_at
           from td_berth_event where td_area = $1 and from_berth is not null
           union all
           select to_berth as berth_code, event_at as observed_at
           from td_berth_event where td_area = $1 and to_berth is not null
         ) observed
         group by berth_code
         having berth_code > $2
         order by berth_code
         limit $3`,
        [area, after, limit],
      );

      const berths = result.rows.map((row) => ({
        berthCode: row.berth_code,
        firstObservedAt: row.first_observed_at.toISOString(),
        lastObservedAt: row.last_observed_at.toISOString(),
        eventCount: Number(row.event_count),
      }));
      const last = berths.at(-1);

      reply.send({ berths, nextCursor: berths.length === limit && last ? last.berthCode : null });
    },
  );

  app.get<{
    Params: { area: string };
    Querystring: { from?: string; to?: string; after?: string; limit?: string };
  }>("/api/v1/td/areas/:area/s-class/events", async (request, reply) => {
    const rangeResult = parseTimeRange(request.query);
    if (!rangeResult.ok) {
      reply.code(400);
      return rangeResult.error;
    }
    const limit = parseLimit(request.query.limit);
    const after = request.query.after ?? "0";

    const result = await pool.query<SClassEventRow>(
      `select id, message_type, address, raw_value, decode_status, event_at, ingestion_sequence
         from td_s_event
         where td_area = $1 and event_at >= $2 and event_at < $3 and id > $4
         order by event_at asc, id asc
         limit $5`,
      [request.params.area, rangeResult.range.from, rangeResult.range.to, after, limit],
    );

    const events = result.rows.map((row) => ({
      id: row.id,
      messageType: row.message_type,
      address: row.address,
      rawValue: row.raw_value,
      decodeStatus: row.decode_status,
      eventAt: row.event_at.toISOString(),
      ingestionSequence: row.ingestion_sequence,
    }));
    const last = events.at(-1);

    reply.send({ events, nextCursor: events.length === limit && last ? last.id : null });
  });

  app.get<{
    Params: { tdArea: string; berth: string };
    Querystring: { from?: string; to?: string; after?: string; limit?: string };
  }>("/api/v1/berths/:tdArea/:berth/history", async (request, reply) => {
    const rangeResult = parseTimeRange(request.query);
    if (!rangeResult.ok) {
      reply.code(400);
      return rangeResult.error;
    }
    const limit = parseLimit(request.query.limit);
    const after = request.query.after ?? "0";

    const result = await pool.query<OccupancyIntervalRow>(
      `select bo.id, bo.entered_at, bo.left_at, bo.description, bo.entry_reason, bo.exit_reason,
              brr.status as resolution_status, bo.anomaly_flags
       from berth_occupancy bo
       left join berth_run_resolution brr on brr.occupancy_id = bo.id
       where bo.projection_version = $1 and bo.td_area = $2 and bo.berth_code = $3
         and bo.entered_at >= $4 and bo.entered_at < $5 and bo.id > $6
       order by bo.entered_at asc, bo.id asc
       limit $7`,
      [
        TD_PROJECTION_VERSION,
        request.params.tdArea,
        request.params.berth,
        rangeResult.range.from,
        rangeResult.range.to,
        after,
        limit,
      ],
    );

    const intervals = result.rows.map(occupancyToJson);
    const last = result.rows.at(-1);

    reply.send({ intervals, nextCursor: result.rows.length === limit && last ? last.id : null });
  });

  app.get<{
    Params: { description: string };
    Querystring: { from?: string; to?: string; after?: string; limit?: string };
  }>("/api/v1/descriptions/:description/history", async (request, reply) => {
    const rangeResult = parseTimeRange(request.query);
    if (!rangeResult.ok) {
      reply.code(400);
      return rangeResult.error;
    }
    const limit = parseLimit(request.query.limit);
    const after = request.query.after ?? "0";

    const result = await pool.query<OccupancyIntervalRow>(
      `select bo.id, bo.td_area, bo.berth_code, bo.entered_at, bo.left_at, bo.description,
              bo.entry_reason, bo.exit_reason, brr.status as resolution_status, bo.anomaly_flags
       from berth_occupancy bo
       left join berth_run_resolution brr on brr.occupancy_id = bo.id
       where bo.projection_version = $1 and bo.description = $2
         and bo.entered_at >= $3 and bo.entered_at < $4 and bo.id > $5
       order by bo.entered_at asc, bo.id asc
       limit $6`,
      [
        TD_PROJECTION_VERSION,
        request.params.description,
        rangeResult.range.from,
        rangeResult.range.to,
        after,
        limit,
      ],
    );

    const intervals = result.rows.map(occupancyToJson);
    const last = result.rows.at(-1);

    reply.send({ intervals, nextCursor: result.rows.length === limit && last ? last.id : null });
  });
}
