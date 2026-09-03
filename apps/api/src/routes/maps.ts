import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { berthChangesForEvent } from "@railway/domain";
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
    Querystring: { from?: string; to?: string; after?: string; limit?: string };
  }>("/api/v1/maps/:slug/events", async (request, reply) => {
    const rangeResult = parseTimeRange(request.query);
    if (!rangeResult.ok) {
      reply.code(400);
      return rangeResult.error;
    }
    const limit = parseLimit(request.query.limit);
    const after = request.query.after ?? "0";

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

    const result = await pool.query<TdBerthEventRow>(
      `select be.ingestion_sequence::text, be.event_at, be.message_type, be.td_area,
              be.from_berth, be.to_berth, be.description
         from td_berth_event be
         join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
           on wanted.td_area = be.td_area
          and (wanted.berth_code = be.from_berth or wanted.berth_code = be.to_berth)
        where be.message_type in ('CA', 'CB', 'CC')
          and be.event_at >= $3 and be.event_at < $4
          and be.ingestion_sequence > $5
        order by be.ingestion_sequence asc
        limit $6`,
      [tdAreas, berthCodes, rangeResult.range.from, rangeResult.range.to, after, limit],
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
    return {
      mapSlug: version.slug,
      mapVersion: version.version_number,
      events,
      nextCursor: result.rows.length === limit && last ? last.ingestion_sequence : null,
    };
  });
}
