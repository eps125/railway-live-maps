import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
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
 *
 * Owner request 2026-10-13: `*` in `tdAreas` means every area. `td_berth_event` has no index on
 * `description`, so dropping the area filter would read a week of nationwide steps — and so does
 * naming every area the headcode was seen in (1A23: 40 areas in a week; over 60 s on production).
 * Instead the headcode's occupancy intervals are read from `berth_occupancy` (indexed on
 * `(description, entered_at)`), and the raw steps that opened and closed them are fetched by their
 * source event on `td_berth_event`'s `(raw_event_id, event_at)` unique index. Measured on
 * production: 1A23 over 7 days, 5,400 lookups, 11 s on a cold cache; a freight headcode 0.4 s.
 *
 * What a `*` search therefore cannot show, and a named area can: a step the projector attached to
 * no interval (a cancel of a berth that did not hold the headcode — a `td_projection_anomaly`),
 * the newest few seconds the projection has not reached yet, and the exit of an interval that
 * began more than `ALL_AREAS_ENTRY_SLACK_MS` before `from`.
 */
const ALL_AREAS = "*";
/** How far before `from` an occupancy may have begun and still have its exit step found by a `*`
 * search. */
const ALL_AREAS_ENTRY_SLACK_MS = 24 * 60 * 60 * 1000;
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
 * entirely — roughly 1.5 GB per monthly partition, so it needs the owner's decision.
 * 2026-10-22: a *pair* search no longer reads area steps (it matches occupancy exits with entries,
 * below), so the lookback now bounds only the single-berth search. */
const PAIR_STEPS_LOOKBACK_CHOICES = [1, 7, 30, 90];
const PAIR_STEPS_DEFAULT_DAYS = 7;
/** A berth-pair search is a diagnostic: give up rather than hold a connection for minutes. */
const PAIR_STEPS_TIMEOUT_MS = 15_000;
/** 2026-09-27: after this long, no further day is started — the search returns what it has found
 * and says how far back it got. On a cold cache one busy area-day (CL) was measured at 12 s, so a
 * berth active every day can't always fill 50 steps in time; a partial answer beats a failure. */
const PAIR_STEPS_BUDGET_MS = 20_000;
/** A pair's step is found from the first berth's occupancy exit: how long before the window that
 * occupancy may have begun (a train standing in the first berth) - the `*` search's slack. */
const PAIR_STEPS_FROM_SLACK_S = ALL_AREAS_ENTRY_SLACK_MS / 1000;

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
        return apiError(
          "VALIDATION_ERROR",
          "tdAreas (comma-separated, at least one, or * for all) is required",
        );
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

      const result = tdAreas.includes(ALL_AREAS)
        ? await pool.query<BerthEventRow>(
            `with occupancy as materialized (
               select entry_event_id, entered_at, exit_event_id, left_at
                 from berth_occupancy
                where projection_version = $1 and description = $2
                  and entered_at >= $3 and entered_at < $5
             ),
             source_event as (
               select entry_event_id as raw_event_id, entered_at as event_at
                 from occupancy
                where entered_at >= $4
               union
               select exit_event_id, left_at
                 from occupancy
                where exit_event_id is not null and left_at >= $4 and left_at < $5
             )
             select e.id, e.td_area, e.message_type, e.from_berth, e.to_berth, e.description,
                    e.event_at, e.ingestion_sequence
               from source_event s
               join td_berth_event e on e.raw_event_id = s.raw_event_id and e.event_at = s.event_at
              where e.description = $2 and e.id > $6
              order by e.event_at asc, e.id asc
              limit $7`,
            [
              TD_PROJECTION_VERSION,
              headcode,
              new Date(rangeResult.range.from.getTime() - ALL_AREAS_ENTRY_SLACK_MS),
              rangeResult.range.from,
              rangeResult.range.to,
              after,
              limit,
            ],
          )
        : await pool.query<BerthEventRow>(
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
   * A single berth is read from `td_berth_event` newest first on the `(td_area, event_at)` index,
   * within the chosen look-back — but only on the days `td_berth_daily_activity` (Milestone 72)
   * says the berth was active. A pair is read from `berth_occupancy` (2026-10-22, below). Owner report
   * 2026-09-27: a berth never seen in the area (CL A475) timed out even at 7 days, because proving
   * "no steps" meant reading every CL step in the period — on a cold cache over 50 s. Now it is
   * one small index read and an instant empty answer. That table is written in the same
   * transaction as the steps themselves, so it never lags them.
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
      if (!singleBerth) {
        // A step from one berth to the next closes the train's occupancy of the first and opens one
        // in the second, both on the same TD message - so a pair's steps are the second berth's
        // entries whose event is the first berth's exit. Both come from `berth_occupancy`'s
        // (td_area, berth_code, entered_at) index: no read of the area's whole step history.
        // Owner report 2026-10-22: R1 3217 -> 5221 timed out at 90, 30 and 14 days - two busy
        // berths, so every day was "active" and each cold area-day read ~19k heap pages. Measured
        // on production: 90 days in 50-130 ms; the same counts as the old scan over a week
        // (5222 -> 5220: 580, 3217 -> 5221: 4). What it can't show: a step the projector attached
        // to no occupancy (a `td_projection_anomaly`), and the newest seconds it hasn't reached.
        const result = await client.query<StepRow>(
          `with into_to as materialized (
             select entry_event_id, entered_at, description
               from berth_occupancy
              where projection_version = $1 and td_area = $2 and berth_code = $4
                and entered_at >= $5
           ),
           out_of_from as materialized (
             select exit_event_id
               from berth_occupancy
              where projection_version = $1 and td_area = $2 and berth_code = $3
                and entered_at >= $5::timestamptz - make_interval(secs => $6)
                and exit_event_id is not null
           )
           select t.entered_at as event_at, t.description, 'CA' as message_type,
                  $3::text as from_berth, $4::text as to_berth
             from into_to t
             join out_of_from f on f.exit_event_id = t.entry_event_id
            order by t.entered_at desc
            limit $7`,
          [
            TD_PROJECTION_VERSION,
            tdArea,
            fromBerth,
            toBerth,
            since,
            PAIR_STEPS_FROM_SLACK_S,
            limit,
          ],
        );
        await client.query("commit");
        return {
          tdArea,
          fromBerth,
          toBerth,
          days,
          since: since.toISOString(),
          incompleteBefore: null,
          steps: result.rows.map((row) => ({
            eventAt: row.event_at.toISOString(),
            description: row.description,
            messageType: row.message_type,
            fromBerth: row.from_berth,
            toBerth: row.to_berth,
          })),
        };
      }
      const sinceDay = since.toISOString().slice(0, 10);
      const activeDays = singleBerth
        ? await client.query<{ day: string }>(
            `select activity_date::text as day
               from td_berth_daily_activity
              where td_area = $1 and berth = $2 and activity_date >= $3::date
              group by activity_date
              order by activity_date desc`,
            [tdArea, fromBerth, sinceDay],
          )
        : await client.query<{ day: string }>(
            `select activity_date::text as day
               from td_berth_daily_activity
              where td_area = $1 and activity_date >= $4::date
                and ((berth = $2 and events_out > 0) or (berth = $3 and events_in > 0))
              group by activity_date
             having bool_or(berth = $2 and events_out > 0) and bool_or(berth = $3 and events_in > 0)
              order by activity_date desc`,
            [tdArea, fromBerth, toBerth, sinceDay],
          );

      const rows: StepRow[] = [];
      const started = Date.now();
      // Set when the search stopped for time: steps before this were not searched.
      let incompleteBefore: string | null = null;
      for (const [index, { day }] of activeDays.rows.entries()) {
        const dayStart = new Date(`${day}T00:00:00Z`);
        if (index > 0 && Date.now() - started > PAIR_STEPS_BUDGET_MS) {
          incompleteBefore = new Date(dayStart.getTime() + 86_400_000).toISOString();
          break;
        }
        const from = dayStart < since ? since : dayStart;
        const to = new Date(dayStart.getTime() + 86_400_000);
        const query = () =>
          singleBerth
            ? client.query<StepRow>(
                `select event_at, description, message_type, from_berth, to_berth
                   from td_berth_event
                  where td_area = $1 and (from_berth = $2 or to_berth = $2)
                    and event_at >= $3::timestamptz and event_at < $4::timestamptz
                  order by event_at desc, id desc
                  limit $5`,
                [tdArea, fromBerth, from, to, limit - rows.length],
              )
            : client.query<StepRow>(
                `select event_at, description, message_type, from_berth, to_berth
                   from td_berth_event
                  where td_area = $1 and message_type = 'CA' and from_berth = $2 and to_berth = $3
                    and event_at >= $4::timestamptz and event_at < $5::timestamptz
                  order by event_at desc, id desc
                  limit $6`,
                [tdArea, fromBerth, toBerth, from, to, limit - rows.length],
              );
        // After the first day, a day that runs past the statement timeout ends the search with what
        // it has, rather than losing it; the savepoint keeps the transaction usable.
        let result: { rows: StepRow[] };
        if (index === 0) {
          result = await query();
        } else {
          await client.query("savepoint day");
          try {
            result = await query();
            await client.query("release savepoint day");
          } catch (error) {
            if ((error as { code?: string }).code !== "57014") throw error;
            await client.query("rollback to savepoint day");
            incompleteBefore = new Date(dayStart.getTime() + 86_400_000).toISOString();
            break;
          }
        }
        rows.push(...result.rows);
        if (rows.length >= limit) break;
      }
      await client.query("commit");
      return {
        tdArea,
        fromBerth,
        toBerth: singleBerth ? null : toBerth,
        days,
        since: since.toISOString(),
        incompleteBefore,
        steps: rows.map((row) => ({
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
