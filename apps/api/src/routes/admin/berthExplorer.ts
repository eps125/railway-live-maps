import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { apiError } from "../../lib/queryRange.js";

/**
 * Milestone 72 (docs/IMPLEMENTATION_PLAN.md): the admin Berth explorer — which berths a TD area
 * has actually used over a window, and whether each is allocated to a berth on a map yet
 * (published or draft, alone or as part of a combined berth). Web page under the admin "Berths"
 * hub (`/admin/berths/explorer`).
 *
 * Nothing here reads `td_berth_event` across a window. The listing reads
 * `td_berth_daily_activity` (migration 0043: one row per area, UTC day and berth), and a berth's
 * step history reads `td_berth_event` only on the days that table says the berth was active — so
 * a berth used once in 90 days costs one day's read, not ninety.
 */

export interface BerthExplorerRoutesDeps {
  pool: Pool;
}

/** The explorer's window choices, in UTC days (today counts as the first). */
export const EXPLORER_WINDOW_DAYS = [7, 14, 30, 60, 90] as const;
const DEFAULT_WINDOW_DAYS = 7;
const STEPS_DEFAULT_LIMIT = 30;
const STEPS_MAX_LIMIT = 200;
/** How many active days one step-history request may read before handing back a cursor. */
const STEPS_MAX_DAYS_PER_REQUEST = 60;
/** A diagnostic page: give up rather than hold a connection for minutes. */
const EXPLORER_TIMEOUT_MS = 15_000;

const TD_AREA_RE = /^[A-Z0-9]{2}$/;

export interface BerthAllocation {
  kind: "published" | "draft";
  mapSlug: string;
  mapName: string;
  elementId: string;
  /** The map element's own label, when it has one. */
  displayName: string | null;
  /** 1-4 when this berth is one member of a combined berth, else null. */
  combinedOrder: number | null;
  /** Every member of the combined berth in order (including this one), or null when not combined. */
  combinedMembers: Array<{ tdArea: string; berth: string }> | null;
}

export interface ExplorerBerth {
  berth: string;
  eventsIn: number;
  eventsOut: number;
  activeDays: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Only for a berth not seen in the window: when it was last seen at all (null if never). */
  lastSeenEverAt: string | null;
  allocations: BerthAllocation[];
}

export interface ActivityRow {
  berth: string;
  events_in: number;
  events_out: number;
  active_days: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

/** One `tdBerth` binding on a map (published or draft) — any area, since a combined berth may mix
 * areas. `td_area`/`berth` are the binding's own; `element_id` groups combined-berth members. */
export interface BindingRow {
  kind: "published" | "draft";
  map_slug: string;
  map_name: string;
  element_id: string;
  display_name: string | null;
  td_area: string;
  berth: string;
  combined_order: number | null;
}

/**
 * Pure: merges window activity with map bindings into the explorer's rows. Every berth seen in the
 * window is listed; so is every berth of `tdArea` bound on a map but not seen (zero counts), which
 * is how a mistyped or retired binding shows up. Sorted by berth code.
 */
export function mergeExplorerBerths(
  tdArea: string,
  activity: ActivityRow[],
  bindings: BindingRow[],
  lastSeenEver: Map<string, Date>,
): ExplorerBerth[] {
  const membersByElement = new Map<string, BindingRow[]>();
  for (const b of bindings) {
    const key = `${b.kind}|${b.map_slug}|${b.element_id}`;
    const list = membersByElement.get(key) ?? [];
    list.push(b);
    membersByElement.set(key, list);
  }

  const allocationsByBerth = new Map<string, BerthAllocation[]>();
  for (const b of bindings) {
    if (b.td_area !== tdArea) continue;
    const members = membersByElement.get(`${b.kind}|${b.map_slug}|${b.element_id}`) ?? [b];
    const combined = b.combined_order !== null || members.length > 1;
    const list = allocationsByBerth.get(b.berth) ?? [];
    list.push({
      kind: b.kind,
      mapSlug: b.map_slug,
      mapName: b.map_name,
      elementId: b.element_id,
      displayName: b.display_name,
      combinedOrder: b.combined_order,
      combinedMembers: combined
        ? [...members]
            .sort((x, y) => (x.combined_order ?? 99) - (y.combined_order ?? 99))
            .map((m) => ({ tdArea: m.td_area, berth: m.berth }))
        : null,
    });
    allocationsByBerth.set(b.berth, list);
  }
  for (const list of allocationsByBerth.values()) {
    list.sort(
      (x, y) =>
        x.mapSlug.localeCompare(y.mapSlug) ||
        (x.kind === y.kind ? 0 : x.kind === "published" ? -1 : 1),
    );
  }

  const rows: ExplorerBerth[] = activity.map((a) => ({
    berth: a.berth,
    eventsIn: a.events_in,
    eventsOut: a.events_out,
    activeDays: a.active_days,
    firstSeenAt: a.first_seen_at.toISOString(),
    lastSeenAt: a.last_seen_at.toISOString(),
    lastSeenEverAt: null,
    allocations: allocationsByBerth.get(a.berth) ?? [],
  }));
  const seen = new Set(activity.map((a) => a.berth));
  for (const [berth, allocations] of allocationsByBerth) {
    if (seen.has(berth)) continue;
    rows.push({
      berth,
      eventsIn: 0,
      eventsOut: 0,
      activeDays: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastSeenEverAt: lastSeenEver.get(berth)?.toISOString() ?? null,
      allocations,
    });
  }
  return rows.sort((x, y) => x.berth.localeCompare(y.berth));
}

/** Pure: the first UTC date (`YYYY-MM-DD`) of a window of `days` days ending today. */
export function windowStartDate(now: Date, days: number): string {
  return new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Runs `work` on its own connection under a statement timeout, so the timeout can't leak to a
 * pooled session someone else picks up. */
async function withTimeout<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${EXPLORER_TIMEOUT_MS}`);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isTimeout(error: unknown): boolean {
  // 57014 = query_canceled, i.e. the statement timeout.
  return (error as { code?: string }).code === "57014";
}

export async function registerBerthExplorerRoutes(
  app: FastifyInstance,
  deps: BerthExplorerRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/admin/berth-explorer/areas", async () => {
    const result = await pool.query<{ td_area: string; last_event_at: Date | null }>(
      `select td_area, last_event_at from td_area_summary
        where c_class_count > 0 order by td_area`,
    );
    return {
      areas: result.rows.map((r) => ({
        tdArea: r.td_area,
        lastEventAt: r.last_event_at?.toISOString() ?? null,
      })),
    };
  });

  app.get<{ Params: { tdArea: string }; Querystring: { days?: string } }>(
    "/api/v1/admin/berth-explorer/areas/:tdArea/berths",
    async (request, reply) => {
      const tdArea = request.params.tdArea.trim().toUpperCase();
      if (!TD_AREA_RE.test(tdArea)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "tdArea must be two characters");
      }
      const requestedDays = Number(request.query.days ?? DEFAULT_WINDOW_DAYS);
      const days = (EXPLORER_WINDOW_DAYS as readonly number[]).includes(requestedDays)
        ? requestedDays
        : DEFAULT_WINDOW_DAYS;
      const sinceDate = windowStartDate(new Date(), days);

      try {
        return await withTimeout(pool, async (client) => {
          const activity = await client.query<ActivityRow>(
            `select berth,
                    sum(events_in)::int as events_in,
                    sum(events_out)::int as events_out,
                    count(distinct activity_date)::int as active_days,
                    min(first_event_at) as first_seen_at,
                    max(last_event_at) as last_seen_at
               from td_berth_daily_activity
              where td_area = $1 and activity_date >= $2::date
              group by berth`,
            [tdArea, sinceDate],
          );

          // Published: the version of each map in effect now. Draft: every draft's document.
          // Both return every tdBerth binding on an element that has a binding in this area, so
          // a combined berth's members from other areas come back too.
          const bindings = await client.query<BindingRow>(
            `with current_version as (
               select mv.id, mv.canonical_document, m.slug, m.name
                 from map_version mv
                 join map m on m.id = mv.map_id
                where mv.effective_from <= now()
                  and (mv.effective_to is null or mv.effective_to > now())
             ),
             published_elements as (
               select distinct b.map_version_id, b.element_id
                 from map_binding_index b
                 join current_version cv on cv.id = b.map_version_id
                where b.binding_type = 'td_berth' and b.td_area = $1
             ),
             -- Each involved document's elements expanded once and hash-joined, rather than a
             -- per-binding scan of the whole document (measured 0.85 s for PX that way).
             published_names as materialized (
               select cv.id as map_version_id, e ->> 'id' as element_id,
                      e ->> 'displayName' as display_name
                 from current_version cv
                 cross join lateral jsonb_array_elements(cv.canonical_document -> 'elements') as e
                where cv.id in (select map_version_id from published_elements)
             ),
             draft_bindings as (
               select d.id as draft_id, d.slug, coalesce(m.name, d.slug) as name, x
                 from map_draft d
                 left join map m on m.id = d.map_id
                 cross join lateral jsonb_array_elements(d.canonical_document -> 'bindings') as x
                where x ->> 'type' = 'tdBerth'
             ),
             draft_elements as (
               select distinct draft_id, x ->> 'elementId' as element_id
                 from draft_bindings where x ->> 'tdArea' = $1
             ),
             draft_names as materialized (
               select d.id as draft_id, e ->> 'id' as element_id, e ->> 'displayName' as display_name
                 from map_draft d
                 cross join lateral jsonb_array_elements(d.canonical_document -> 'elements') as e
                where d.id in (select draft_id from draft_elements)
             )
             select 'published' as kind, cv.slug as map_slug, cv.name as map_name, b.element_id,
                    pn.display_name, b.td_area, b.berth, b.combined_order::int as combined_order
               from published_elements pe
               join map_binding_index b
                 on b.map_version_id = pe.map_version_id and b.element_id = pe.element_id
                and b.binding_type = 'td_berth'
               join current_version cv on cv.id = b.map_version_id
               left join published_names pn
                 on pn.map_version_id = b.map_version_id and pn.element_id = b.element_id
             union all
             select 'draft', db.slug, db.name, db.x ->> 'elementId', dn.display_name,
                    db.x ->> 'tdArea', db.x ->> 'berth', (db.x ->> 'combinedOrder')::int
               from draft_bindings db
               join draft_elements de
                 on de.draft_id = db.draft_id and de.element_id = db.x ->> 'elementId'
               left join draft_names dn
                 on dn.draft_id = db.draft_id and dn.element_id = db.x ->> 'elementId'`,
            [tdArea],
          );

          const seen = new Set(activity.rows.map((r) => r.berth));
          const unseenBound = [
            ...new Set(
              bindings.rows
                .filter((b) => b.td_area === tdArea && !seen.has(b.berth))
                .map((b) => b.berth),
            ),
          ];
          const lastSeenEver = new Map<string, Date>();
          if (unseenBound.length > 0) {
            const ever = await client.query<{ berth: string; last_seen_at: Date }>(
              `select berth, max(last_event_at) as last_seen_at
                 from td_berth_daily_activity
                where td_area = $1 and berth = any($2::text[])
                group by berth`,
              [tdArea, unseenBound],
            );
            for (const r of ever.rows) lastSeenEver.set(r.berth, r.last_seen_at);
          }

          const coverage = await client.query<{ first_date: string | null }>(
            `select min(activity_date)::text as first_date
               from td_berth_daily_activity where td_area = $1`,
            [tdArea],
          );

          return {
            tdArea,
            days,
            sinceDate,
            coverageFromDate: coverage.rows[0]?.first_date ?? null,
            berths: mergeExplorerBerths(tdArea, activity.rows, bindings.rows, lastSeenEver),
          };
        });
      } catch (error) {
        if (isTimeout(error)) {
          reply.code(504);
          return apiError("SEARCH_TOO_SLOW", "Loading the berths took too long — try again.");
        }
        throw error;
      }
    },
  );

  /**
   * A berth's newest steps — every CA/CB/CC event with this berth as its from or to berth —
   * newest first. Walks the berth's active days from `td_berth_daily_activity` newest first and
   * reads `td_berth_event` for just those days, until `limit` rows are found. Cursor: pass the
   * last row's `eventAt` and `id` back as `before`/`beforeId` for the next page.
   */
  app.get<{
    Params: { tdArea: string; berth: string };
    Querystring: { limit?: string; before?: string; beforeId?: string };
  }>("/api/v1/admin/berth-explorer/areas/:tdArea/berths/:berth/steps", async (request, reply) => {
    const tdArea = request.params.tdArea.trim().toUpperCase();
    const berth = request.params.berth.trim().toUpperCase();
    if (!TD_AREA_RE.test(tdArea) || berth === "") {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "tdArea (two characters) and berth are required");
    }
    const requested = Number(request.query.limit ?? STEPS_DEFAULT_LIMIT);
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, STEPS_MAX_LIMIT)
        : STEPS_DEFAULT_LIMIT;
    const before = request.query.before ? new Date(request.query.before) : null;
    if (before && Number.isNaN(before.getTime())) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "before must be an ISO timestamp");
    }
    const beforeId = request.query.beforeId ?? null;
    if (beforeId !== null && !/^\d+$/.test(beforeId)) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "beforeId must be a step id");
    }

    try {
      return await withTimeout(pool, async (client) => {
        const activeDays = await client.query<{ activity_date: string }>(
          `select activity_date::text as activity_date
             from td_berth_daily_activity
            where td_area = $1 and berth = $2 and activity_date <= $3::date
            group by activity_date
            order by activity_date desc
            limit $4`,
          [
            tdArea,
            berth,
            (before ?? new Date(Date.now() + 86_400_000)).toISOString().slice(0, 10),
            STEPS_MAX_DAYS_PER_REQUEST + 1,
          ],
        );

        const steps: Array<{
          id: string;
          eventAt: string;
          description: string | null;
          messageType: string;
          fromBerth: string | null;
          toBerth: string | null;
        }> = [];
        const days = activeDays.rows.map((r) => r.activity_date);
        let daysRead = 0;
        for (const day of days.slice(0, STEPS_MAX_DAYS_PER_REQUEST)) {
          daysRead += 1;
          const dayStart = new Date(`${day}T00:00:00Z`);
          const dayEnd = new Date(dayStart.getTime() + 86_400_000);
          const result = await client.query<{
            id: string;
            event_at: Date;
            description: string | null;
            message_type: string;
            from_berth: string | null;
            to_berth: string | null;
          }>(
            `select id, event_at, description, message_type, from_berth, to_berth
               from td_berth_event
              where td_area = $1 and (from_berth = $2 or to_berth = $2)
                and event_at >= $3::timestamptz and event_at < $4::timestamptz
                and ($5::timestamptz is null
                     or event_at < $5::timestamptz
                     or ($6::bigint is not null and event_at = $5::timestamptz and id < $6::bigint))
              order by event_at desc, id desc
              limit $7`,
            [tdArea, berth, dayStart, dayEnd, before, beforeId, limit - steps.length],
          );
          for (const row of result.rows) {
            steps.push({
              id: row.id,
              eventAt: row.event_at.toISOString(),
              description: row.description,
              messageType: row.message_type,
              fromBerth: row.from_berth,
              toBerth: row.to_berth,
            });
          }
          if (steps.length >= limit) break;
        }

        const last = steps.at(-1);
        let next: { before: string; beforeId: string | null } | null = null;
        if (steps.length >= limit && last) {
          next = { before: last.eventAt, beforeId: last.id };
        } else if (daysRead < days.length) {
          // Ran out of days for this request, not out of history: resume before the last day read.
          next = { before: `${days[daysRead - 1]}T00:00:00.000Z`, beforeId: null };
        }
        return { tdArea, berth, steps, next };
      });
    } catch (error) {
      if (isTimeout(error)) {
        reply.code(504);
        return apiError("SEARCH_TOO_SLOW", "Loading the steps took too long — try again.");
      }
      throw error;
    }
  });
}
