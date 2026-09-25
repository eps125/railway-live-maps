import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError, parseLimit, parseTimeRange } from "../../lib/queryRange.js";

export interface BerthQueryRoutesDeps {
  pool: Pool;
}

interface BerthEventRow {
  id: string;
  td_area: string;
  message_type: string;
  from_berth: string | null;
  to_berth: string | null;
  description: string | null;
  event_at: Date;
  ingestion_sequence: string;
}

function eventResponse(row: BerthEventRow) {
  return {
    id: row.id,
    tdArea: row.td_area,
    messageType: row.message_type,
    fromBerth: row.from_berth,
    toBerth: row.to_berth,
    description: row.description,
    eventAt: row.event_at.toISOString(),
    ingestionSequence: row.ingestion_sequence,
  };
}

interface QueryQuerystring {
  tdAreas?: string;
  headcode?: string;
  from?: string;
  to?: string;
  after?: string;
  limit?: string;
}

/**
 * Admin-only ad hoc `td_berth_event` lookup by TD area(s) + headcode + time range (the "Query
 * Berths" tool under the web app's "Berths" nav item) — replaces manually asking for a one-off SQL
 * query against raw C-Class events. Unlike `/api/v1/descriptions/:description/history` (which
 * reads the `berth_occupancy` *projection*, one row per dwell), this reads `td_berth_event`
 * directly so the result shows every individual CA/CB/CC/CT step with its from/to berth pair, not
 * just the resulting occupancy interval.
 *
 * `tdAreas` is required (comma-separated list) so the query always has the selective
 * `(td_area, event_at)` index (`td_berth_event_area_idx`, migration 0006) to lean on — see
 * memory/docs on the ingestion_sequence-vs-area-index planner pitfall confirmed on this same
 * table; ordering here is by `event_at` (part of that index), not a global sequence column, so the
 * planner has no reason to prefer anything else.
 */
/** Owner request 2026-09-22 ("Berth steps"): how many of the newest steps between a pair of
 * berths to return. */
const PAIR_STEPS_DEFAULT_LIMIT = 50;
const PAIR_STEPS_MAX_LIMIT = 200;
/** How far back the search may look, in days — the author picks one of these.
 *
 * There is no index on the berth pair (only `(td_area, event_at)`), so the lookback is what bounds
 * the work: a pair that *does* step stops at `limit` matches, but a rare or never-stepping pair
 * reads every step of the area in the window. Measured on production 2026-09-22 for M9: 24 h is
 * ~5k steps (instant), while the original 90-day default read ~160k steps and over a gigabyte of
 * heap — minutes on a cold cache, which is what the owner hit ("3894 -> 9878", a pair with no
 * steps at all). Kept as a choice, with a timeout, rather than silently allowing a query that can
 * run for minutes. An index on (td_area, from_berth, to_berth, event_at) would remove the limit
 * entirely — roughly 1.5 GB per monthly partition, so it needs the owner's decision. */
const PAIR_STEPS_LOOKBACK_CHOICES = [1, 7, 30, 90];
const PAIR_STEPS_DEFAULT_DAYS = 7;
/** A berth-pair search is a diagnostic: give up rather than hold a connection for minutes. */
const PAIR_STEPS_TIMEOUT_MS = 15_000;

interface StepRow {
  event_at: Date;
  description: string | null;
  message_type: string;
  from_berth: string | null;
  to_berth: string | null;
}

export async function registerBerthQueryRoutes(
  app: FastifyInstance,
  deps: BerthQueryRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Querystring: QueryQuerystring }>(
    "/api/v1/admin/berths/query",
    async (request, reply) => {
      const tdAreas = (request.query.tdAreas ?? "")
        .split(",")
        .map((area) => area.trim().toUpperCase())
        .filter((area) => area.length > 0);
      if (tdAreas.length === 0) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "tdAreas (comma-separated, at least one) is required");
      }

      const headcode = (request.query.headcode ?? "").trim();
      if (!headcode) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "headcode is required");
      }

      const rangeResult = parseTimeRange(request.query);
      if (!rangeResult.ok) {
        reply.code(400);
        return rangeResult.error;
      }
      const limit = parseLimit(request.query.limit);
      const after = request.query.after ?? "0";

      const result = await pool.query<BerthEventRow>(
        `select id, td_area, message_type, from_berth, to_berth, description, event_at,
                ingestion_sequence
         from td_berth_event
         where td_area = any($1) and description = $2
           and event_at >= $3 and event_at < $4 and id > $5
         order by event_at asc, id asc
         limit $6`,
        [tdAreas, headcode, rangeResult.range.from, rangeResult.range.to, after, limit],
      );

      const events = result.rows.map(eventResponse);
      const last = result.rows.at(-1);

      reply.send({ events, nextCursor: result.rows.length === limit && last ? last.id : null });
    },
  );

  /**
   * Owner request 2026-09-22: the newest berth steps (CA) from one berth to another in one TD
   * area — when trains last stepped between a pair of berths, and with what description.
   *
   * Owner request 2026-09-25: `toBerth` may be left out, and then it lists every step *at*
   * `fromBerth` instead — into it or out of it — with each row's type (CA step, CB cancel, CC
   * interpose) and its own from/to berths. CT heartbeats carry no berth, so never match.
   *
   * Both read `td_berth_event` newest first on the `(td_area, event_at)` index, within the chosen
   * look-back.
   */
  app.get<{
    Querystring: {
      tdArea?: string;
      fromBerth?: string;
      toBerth?: string;
      limit?: string;
      days?: string;
    };
  }>("/api/v1/admin/berths/steps", async (request, reply) => {
    const tdArea = (request.query.tdArea ?? "").trim().toUpperCase();
    const fromBerth = (request.query.fromBerth ?? "").trim().toUpperCase();
    const toBerth = (request.query.toBerth ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2}$/.test(tdArea) || fromBerth === "") {
      reply.code(400);
      return apiError(
        "VALIDATION_ERROR",
        "tdArea (two characters) and fromBerth are required; toBerth is optional",
      );
    }
    const singleBerth = toBerth === "";
    const requested = Number(request.query.limit ?? PAIR_STEPS_DEFAULT_LIMIT);
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, PAIR_STEPS_MAX_LIMIT)
        : PAIR_STEPS_DEFAULT_LIMIT;
    const requestedDays = Number(request.query.days ?? PAIR_STEPS_DEFAULT_DAYS);
    const days = PAIR_STEPS_LOOKBACK_CHOICES.includes(requestedDays)
      ? requestedDays
      : PAIR_STEPS_DEFAULT_DAYS;
    const since = new Date(Date.now() - days * 86_400_000);

    // Its own connection, so the timeout applies to this query alone and can't leak to a pooled
    // session someone else picks up.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local statement_timeout = ${PAIR_STEPS_TIMEOUT_MS}`);
      const result = singleBerth
        ? await client.query<StepRow>(
            `select event_at, description, message_type, from_berth, to_berth
               from td_berth_event
              where td_area = $1 and (from_berth = $2 or to_berth = $2)
                and event_at >= $3::timestamptz
              order by event_at desc, id desc
              limit $4`,
            [tdArea, fromBerth, since, limit],
          )
        : await client.query<StepRow>(
            `select event_at, description, message_type, from_berth, to_berth
               from td_berth_event
              where td_area = $1 and message_type = 'CA' and from_berth = $2 and to_berth = $3
                and event_at >= $4::timestamptz
              order by event_at desc, id desc
              limit $5`,
            [tdArea, fromBerth, toBerth, since, limit],
          );
      await client.query("commit");
      return {
        tdArea,
        fromBerth,
        toBerth: singleBerth ? null : toBerth,
        days,
        since: since.toISOString(),
        steps: result.rows.map((row) => ({
          eventAt: row.event_at.toISOString(),
          description: row.description,
          messageType: row.message_type,
          fromBerth: row.from_berth,
          toBerth: row.to_berth,
        })),
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      // 57014 = query_canceled, i.e. the statement timeout above.
      if ((error as { code?: string }).code === "57014") {
        reply.code(504);
        return apiError(
          "SEARCH_TOO_SLOW",
          singleBerth
            ? `Searching ${days} days took too long — try a shorter period. A berth that is rarely used is the slowest case, because every step in the period has to be checked.`
            : `Searching ${days} days took too long — try a shorter period. A pair that never steps is the slowest case, because every step in the period has to be checked.`,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  });
}
