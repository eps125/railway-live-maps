import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { SIGNAL_GAP_TOLERANCE_MS } from "@railway/domain";
import { apiError } from "../../lib/queryRange.js";

export interface OutageRoutesDeps {
  pool: Pool;
  /** For tests; defaults to the wall clock. */
  now?: () => Date;
}

export const DEFAULT_OUTAGE_DAYS = 30;
export const MAX_OUTAGE_DAYS = 365;

interface FeedGapRow {
  id: string;
  feed_name: string;
  td_area: string | null;
  window_start: Date;
  window_end: Date | null;
  detection_reason: string;
  recoverability: "recoverable" | "unrecoverable" | "unknown";
  operator_note: string | null;
  created_at: Date;
}

function outageResponse(row: FeedGapRow) {
  return {
    id: row.id,
    feed: row.feed_name,
    tdArea: row.td_area,
    start: row.window_start.toISOString(),
    end: row.window_end ? row.window_end.toISOString() : null,
    durationSeconds: row.window_end
      ? Math.round((row.window_end.getTime() - row.window_start.getTime()) / 1000)
      : null,
    reason: row.detection_reason,
    recoverability: row.recoverability,
    note: row.operator_note,
    recordedAt: row.created_at.toISOString(),
  };
}

/** `?days=` for the outage list: a whole number of days, 1 to `MAX_OUTAGE_DAYS`. */
export function parseOutageDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_OUTAGE_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= MAX_OUTAGE_DAYS ? days : null;
}

/**
 * Whether TD is silent right now. A `feed_gap` row is only written once a silence has ended (the
 * projector finds it between two received rows), so an outage still in progress has no row yet:
 * this is how the page and the pill show one anyway. Same tolerance as the recorded gaps.
 */
export function liveTdStatus(lastFrameAt: Date | null, now: Date) {
  const silentForMs = lastFrameAt ? Math.max(0, now.getTime() - lastFrameAt.getTime()) : null;
  return {
    lastFrameAt: lastFrameAt ? lastFrameAt.toISOString() : null,
    silentForSeconds: silentForMs === null ? null : Math.round(silentForMs / 1000),
    ongoing: silentForMs === null || silentForMs > SIGNAL_GAP_TOLERANCE_MS,
  };
}

async function lastTdFrameAt(pool: Pool): Promise<Date | null> {
  // By primary key, newest first: `max(received_at)` only has a BRIN index to use.
  const result = await pool.query<{ received_at: Date }>(
    `select received_at from feed_frame where feed_name = 'TD' order by id desc limit 1`,
  );
  return result.rows[0]?.received_at ?? null;
}

async function seenThrough(pool: Pool, userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const result = await pool.query<{ seen: string }>(
    `select seen_through_gap_id::text as seen from feed_gap_seen where user_id = $1`,
    [userId],
  );
  return result.rows[0]?.seen ?? "0";
}

/**
 * 2026-10-30 (owner request): the admin "Data outages" page — every recorded `feed_gap` (TD
 * receive silences longer than the signal-trust tolerance, and any recorded by hand), whether TD
 * is silent right now, and a per-user unseen count for the pill on the Admin link. Viewing the
 * page marks what it showed as seen. Behind `map.feed_gap_details`, the permission that already
 * gates outage details on the maps.
 */
export async function registerOutageRoutes(
  app: FastifyInstance,
  deps: OutageRoutesDeps,
): Promise<void> {
  const { pool } = deps;
  const now = deps.now ?? (() => new Date());

  app.get<{ Querystring: { days?: string } }>("/api/v1/admin/outages", async (request, reply) => {
    const days = parseOutageDays(request.query.days);
    if (days === null) {
      reply.code(400);
      return apiError(
        "VALIDATION_ERROR",
        `days must be a whole number from 1 to ${MAX_OUTAGE_DAYS}`,
      );
    }
    const at = now();
    const [gaps, lastFrame, seen] = await Promise.all([
      pool.query<FeedGapRow>(
        `select id::text as id, feed_name, td_area,
                coalesce(affected_time_start, detected_start) as window_start,
                coalesce(affected_time_end, detected_end)     as window_end,
                detection_reason, recoverability, operator_note, created_at
           from feed_gap
          where coalesce(affected_time_end, detected_end, $1) >= $1::timestamptz - make_interval(days => $2)
          order by window_start desc
          limit 500`,
        [at, days],
      ),
      lastTdFrameAt(pool),
      seenThrough(pool, request.viewer?.user?.id),
    ]);
    return {
      days,
      outages: gaps.rows.map(outageResponse),
      liveTd: liveTdStatus(lastFrame, at),
      seenThroughGapId: seen,
    };
  });

  app.get("/api/v1/admin/outages/summary", async (request) => {
    const userId = request.viewer?.user?.id;
    const [unseen, lastFrame] = await Promise.all([
      userId
        ? pool.query<{ unseen: number }>(
            `select count(*)::int as unseen from feed_gap
              where id > coalesce((select seen_through_gap_id from feed_gap_seen where user_id = $1), 0)`,
            [userId],
          )
        : null,
      lastTdFrameAt(pool),
    ]);
    return {
      unseen: unseen?.rows[0]?.unseen ?? 0,
      ongoing: liveTdStatus(lastFrame, now()).ongoing,
    };
  });

  app.post<{ Body: { throughGapId?: unknown } }>(
    "/api/v1/admin/outages/seen",
    async (request, reply) => {
      const through = request.body?.throughGapId;
      if (typeof through !== "string" || !/^\d{1,18}$/.test(through)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "throughGapId (a feed_gap id) is required");
      }
      const userId = request.viewer?.user?.id;
      // An access-code holder has no user to remember it against; nothing to do.
      if (!userId) return reply.code(204).send();
      // Never past a gap that exists, and never backwards (two tabs, an older page load).
      await pool.query(
        `insert into feed_gap_seen (user_id, seen_through_gap_id, seen_at)
         values ($1, least($2::bigint, coalesce((select max(id) from feed_gap), 0)), now())
         on conflict (user_id) do update
           set seen_through_gap_id = greatest(feed_gap_seen.seen_through_gap_id,
                                              excluded.seen_through_gap_id),
               seen_at = now()`,
        [userId, through],
      );
      return reply.code(204).send();
    },
  );
}
