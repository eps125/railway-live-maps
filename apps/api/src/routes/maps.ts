import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { berthChangesForEvent, VIRTUAL_BERTH_PROJECTION_VERSION } from "@railway/domain";
import type { CompiledMapBundle } from "@railway/map-schema";
import type { LiveDeltaMessage } from "@railway/protocol";
import { apiError, parseLimit, parseTimeRange } from "../lib/queryRange.js";
import { currentVersionForSlug, tdAreasFromBundle, liveDataStatus } from "../lib/mapVersion.js";
import { computeLiveState } from "../lib/liveState.js";
import { reconstructStateAt } from "../lib/reconstructState.js";

export interface MapRoutesDeps {
  pool: Pool;
}

interface MapVersionRow {
  id: string;
  slug: string;
  name: string;
  version_number: number;
  compiled_runtime_bundle: CompiledMapBundle;
  effective_from: Date;
  effective_to: Date | null;
}

/** How far `at` may drift from "now" before /state treats it as a real point-in-time request
 * rather than float/clock-skew noise. Within the window → live state; outside (past) →
 * historical reconstruction (Milestone 10); outside (future) → 400. */
const LIVE_STATE_TOLERANCE_MS = 5_000;

interface TdBerthEventRow {
  ingestion_sequence: string;
  event_at: Date;
  message_type: "CA" | "CB" | "CC";
  td_area: string;
  from_berth: string | null;
  to_berth: string | null;
  description: string | null;
}

interface VirtualOccupancyRow {
  id: string;
  stanox: string;
  headcode: string | null;
  entered_at: Date;
  left_at: Date | null;
}

/** Canonical map schema + basic Lancaster renderer endpoints (docs/IMPLEMENTATION_PLAN.md
 * Milestone 5) plus Milestone 10 playback: historical `/state?at=` reconstruction and the
 * compact `/events` stream (docs/API_CONTRACT.md §1, §3). Live WebSocket push is Milestone 6
 * (`routes/liveMap.ts`); the editor API is Milestone 11/12. */
export async function registerMapRoutes(app: FastifyInstance, deps: MapRoutesDeps): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/maps", async () => {
    const now = new Date();
    const result = await pool.query<MapVersionRow>(
      `select mv.id, m.slug, m.name, mv.version_number, mv.compiled_runtime_bundle, mv.effective_from, mv.effective_to
       from map_version mv
       join map m on m.id = mv.map_id
       where mv.effective_from <= $1 and (mv.effective_to is null or mv.effective_to > $1)
       order by m.slug`,
      [now],
    );

    const maps = await Promise.all(
      result.rows.map(async (row) => ({
        slug: row.slug,
        name: row.name,
        mapVersion: row.version_number,
        liveDataStatus: await liveDataStatus(
          pool,
          tdAreasFromBundle(row.compiled_runtime_bundle),
          now,
        ),
      })),
    );

    return { maps };
  });

  app.get<{ Params: { slug: string }; Querystring: { at?: string } }>(
    "/api/v1/maps/:slug/definition",
    async (request, reply) => {
      const at = request.query.at ? new Date(request.query.at) : new Date();
      if (Number.isNaN(at.getTime())) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", "at must be a valid ISO 8601 timestamp");
      }

      const version = await currentVersionForSlug(pool, request.params.slug, at);
      if (!version) {
        reply.code(404);
        return apiError(
          "MAP_NOT_FOUND",
          `No published version of "${request.params.slug}" is effective at ${at.toISOString()}`,
        );
      }

      return {
        mapSlug: version.slug,
        mapVersion: version.version_number,
        effectiveFrom: version.effective_from.toISOString(),
        effectiveTo: version.effective_to ? version.effective_to.toISOString() : null,
        definition: version.compiled_runtime_bundle,
      };
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { at?: string } }>(
    "/api/v1/maps/:slug/state",
    async (request, reply) => {
      const now = new Date();
      const at = request.query.at ? new Date(request.query.at) : now;
      if (Number.isNaN(at.getTime())) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", "at must be a valid ISO 8601 timestamp");
      }
      if (at.getTime() - now.getTime() > LIVE_STATE_TOLERANCE_MS) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", "at must not be in the future");
      }

      const historical = now.getTime() - at.getTime() > LIVE_STATE_TOLERANCE_MS;
      // Live → the version effective now; historical → the version effective at `at`
      // (docs/IMPLEMENTATION_PLAN.md M10: "Map-version selection by effective time").
      const version = await currentVersionForSlug(pool, request.params.slug, historical ? at : now);
      if (!version) {
        reply.code(404);
        return apiError(
          "MAP_NOT_FOUND",
          historical
            ? `No published version of "${request.params.slug}" was effective at ${at.toISOString()}`
            : `No published version of "${request.params.slug}" is currently effective`,
        );
      }

      const { sourceSequence, berths, signals, quality } = historical
        ? await reconstructStateAt(pool, version.compiled_runtime_bundle, at)
        : await computeLiveState(pool, version.compiled_runtime_bundle, now);

      return {
        mapSlug: version.slug,
        mapVersion: version.version_number,
        asOf: at.toISOString(),
        sourceSequence,
        mode: historical ? ("historical" as const) : ("live" as const),
        quality,
        berths,
        signals,
      };
    },
  );

  // Milestone 10 (docs/API_CONTRACT.md §1, §3): compact map-relevant events for playback
  // buffering. One CA can yield two entries (from clears, to updates); each entry is the same
  // wire shape as a live WS `berth.updated` / `berth.cleared` delta, so the playback client
  // applies them with the exact code path it applies live deltas with. Cursor is
  // `td_berth_event.ingestion_sequence` (globally unique per C-Class row); `from`/`to` bound the
  // range (max 7 days, per `parseTimeRange`).
  app.get<{
    Params: { slug: string };
    Querystring: {
      from?: string;
      to?: string;
      after?: string;
      afterVirtual?: string;
      limit?: string;
    };
  }>("/api/v1/maps/:slug/events", async (request, reply) => {
    const rangeResult = parseTimeRange(request.query);
    if (!rangeResult.ok) {
      reply.code(400);
      return rangeResult.error;
    }
    const limit = parseLimit(request.query.limit);
    const after = request.query.after ?? "0";
    const afterVirtual = request.query.afterVirtual ?? "0";

    // Definition (bindings) as they were at the start of the requested window.
    const version = await currentVersionForSlug(pool, request.params.slug, rangeResult.range.from);
    if (!version) {
      reply.code(404);
      return apiError(
        "MAP_NOT_FOUND",
        `No published version of "${request.params.slug}" was effective at ${rangeResult.range.from.toISOString()}`,
      );
    }
    const bundle = version.compiled_runtime_bundle;
    const berthKeys = Object.keys(bundle.berthBindingIndex);
    const tdAreas = berthKeys.map((key) => key.split("|")[0] ?? "");
    const berthCodes = berthKeys.map((key) => key.split("|")[1] ?? "");
    const distinctTdAreas = tdAreasFromBundle(bundle);

    // `candidates` is `materialized` so the planner can't fold the (td_area, berth_code) pairing
    // join into it and pick a plan driven by `ingestion_sequence` instead. Without the fence,
    // Postgres favours the `ingestion_sequence` index (it directly satisfies `order by ... limit`)
    // over the far more selective `td_berth_event_area_idx (td_area, event_at desc)` — and since
    // this table is nationwide (every nationwide event <7 days) that scans tens of millions of
    // other areas' rows before the row cap is reached, timing out (504) at the proxy for anything
    // but a very recent jump. Filtering `td_area = any(distinct areas)` first (2-4 areas for a
    // typical map, not 181 unnested berth pairs) forces the composite index; only the resulting
    // small candidate set then gets the exact (td_area, berth_code) pairing check. Verified via
    // `EXPLAIN ANALYZE` against production 2026-09-14: ~21s (this table's real nationwide volume)
    // down to <1s for a 30-minute window (docs/adr — playback 504 investigation).
    const result = await pool.query<TdBerthEventRow>(
      `with candidates as materialized (
         select be.ingestion_sequence, be.event_at, be.message_type, be.td_area,
                be.from_berth, be.to_berth, be.description
           from td_berth_event be
          where be.td_area = any($1::text[])
            and be.message_type in ('CA', 'CB', 'CC')
            and be.event_at >= $2 and be.event_at < $3
       )
       select c.ingestion_sequence::text, c.event_at, c.message_type, c.td_area,
              c.from_berth, c.to_berth, c.description
         from candidates c
         join (select unnest($4::text[]) as td_area, unnest($5::text[]) as berth_code) wanted
           on wanted.td_area = c.td_area
          and (wanted.berth_code = c.from_berth or wanted.berth_code = c.to_berth)
        where c.ingestion_sequence > $6
        order by c.ingestion_sequence asc
        limit $7`,
      [
        distinctTdAreas,
        rangeResult.range.from,
        rangeResult.range.to,
        tdAreas,
        berthCodes,
        after,
        limit,
      ],
    );

    const events: LiveDeltaMessage[] = [];
    for (const row of result.rows) {
      const sequence = Number(row.ingestion_sequence);
      const changes = berthChangesForEvent({
        messageType: row.message_type,
        tdArea: row.td_area,
        fromBerth: row.from_berth,
        toBerth: row.to_berth,
        description: row.description ?? "",
        eventAt: row.event_at.toISOString(),
      });
      for (const change of changes) {
        const elementId = bundle.berthBindingIndex[`${change.tdArea}|${change.berth}`];
        if (!elementId) continue; // the other half of a CA whose berth this map doesn't bind
        events.push(
          change.description === null
            ? {
                type: "berth.cleared",
                sequence,
                eventAt: change.eventAt,
                elementId,
                tdArea: change.tdArea,
                berth: change.berth,
              }
            : {
                type: "berth.updated",
                sequence,
                eventAt: change.eventAt,
                elementId,
                tdArea: change.tdArea,
                berth: change.berth,
                description: change.description,
                enteredAt: change.eventAt,
              },
        );
      }
    }

    const last = result.rows.at(-1);

    // docs/adr/0012 gap closure (owner request, 2026-09-19): virtual (GPS-fed) berth playback
    // events, merged into the same response. `virtual_berth_occupancy` intervals span two
    // far-apart instants (entered_at, left_at) instead of TD's single `event_at`, so a plain
    // row-id cursor can't page it the way `ingestion_sequence` pages TD: a row whose entry
    // already fell inside an earlier page's window can still be *open* (no `left_at` yet), and
    // its eventual exit event must remain reachable on a later page once `to` grows far enough.
    // Cursor is therefore `virtualOccupancyId * 2 (+1 for the exit)` — a distinct, individually
    // resumable position per event rather than per row: once a row's entry has been sent its
    // cursor sits exactly on `entryCursor`, so a repeat request with that same cursor correctly
    // excludes the entry (`> afterVirtual` fails on equality) while still admitting the exit
    // (`exitCursor = entryCursor + 1n` still passes) the moment `left_at` lands in `[from, to)` —
    // no re-send, no data loss, no need to advance past a row before it's fully resolved.
    // `nextVirtualCursor` still deliberately stops advancing *past* the first still-open row it
    // meets (in id order): later rows' events are still returned this page, but the cursor can't
    // skip over the open row without risking its eventual exit being unreachable on a future page
    // once `to` grows far enough to cover it.
    const virtualBerthBindingIndex = bundle.virtualBerthBindingIndex ?? {};
    const stanoxes = Object.keys(virtualBerthBindingIndex);
    let nextVirtualCursor: string | null = null;
    if (stanoxes.length > 0) {
      const afterVirtualBig = BigInt(afterVirtual);
      const minId = afterVirtualBig / 2n; // floor division; inclusive re-check below
      const virtualResult = await pool.query<VirtualOccupancyRow>(
        `select vbo.id::text, vbo.stanox, vbo.headcode, vbo.entered_at, vbo.left_at
           from virtual_berth_occupancy vbo
          where vbo.projection_version = $1
            and vbo.stanox = any($2::text[])
            and vbo.id >= $3::bigint
            and vbo.entered_at < $4
            and (vbo.left_at is null or vbo.left_at >= $5)
          order by vbo.id asc
          limit $6`,
        [
          VIRTUAL_BERTH_PROJECTION_VERSION,
          stanoxes,
          minId.toString(),
          rangeResult.range.to,
          rangeResult.range.from,
          limit,
        ],
      );

      let runningCursor = afterVirtualBig;
      let blocked = false;
      for (const row of virtualResult.rows) {
        if (blocked) break;
        const elementId = virtualBerthBindingIndex[row.stanox];
        if (!elementId) continue;
        const rowId = BigInt(row.id);
        const entryCursor = rowId * 2n;
        const exitCursor = rowId * 2n + 1n;
        const enteredAtMs = row.entered_at.getTime();
        const leftAtMs = row.left_at ? row.left_at.getTime() : null;

        const includeEntry =
          entryCursor > afterVirtualBig &&
          enteredAtMs >= rangeResult.range.from.getTime() &&
          enteredAtMs < rangeResult.range.to.getTime();
        if (includeEntry) {
          events.push({
            type: "berth.updated",
            sequence: Number(entryCursor),
            eventAt: row.entered_at.toISOString(),
            elementId,
            stanox: row.stanox,
            description: row.headcode ?? "",
            enteredAt: row.entered_at.toISOString(),
          });
        }

        const includeExit =
          row.left_at !== null &&
          leftAtMs !== null &&
          exitCursor > afterVirtualBig &&
          leftAtMs >= rangeResult.range.from.getTime() &&
          leftAtMs < rangeResult.range.to.getTime();
        if (includeExit && row.left_at) {
          events.push({
            type: "berth.cleared",
            sequence: Number(exitCursor),
            eventAt: row.left_at.toISOString(),
            elementId,
            stanox: row.stanox,
          });
        }

        if (row.left_at === null) {
          // Still open — never advance the watermark past this row's entry; its exit must
          // remain reachable on a future page once it closes.
          if (entryCursor > runningCursor) runningCursor = entryCursor;
          blocked = true;
        } else {
          runningCursor = exitCursor;
        }
      }
      nextVirtualCursor = runningCursor > afterVirtualBig ? runningCursor.toString() : null;
    }

    // Merge, sorted by `eventAt` so a client that applies buffered events strictly in array
    // order (apps/web/src/map/usePlayback.ts) sees TD and virtual transitions interleaved in
    // the order they actually happened, not grouped by source.
    events.sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt));

    return {
      mapSlug: version.slug,
      mapVersion: version.version_number,
      events,
      nextCursor: result.rows.length === limit && last ? last.ingestion_sequence : null,
      nextVirtualCursor,
    };
  });
}
