import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { CompiledMapBundle } from "@railway/map-schema";
import { apiError } from "../lib/queryRange.js";

export interface MapRoutesDeps {
  pool: Pool;
}

/** MVP freshness window for the "live-data status" summary and /state's quality flag. Not yet
 * wired to configuration (docs/ARCHITECTURE.md §9 lists "freshness thresholds" as a setting to
 * add later) — a fixed, documented constant is the smallest coherent implementation for now. */
const FRESHNESS_THRESHOLD_MS = 90_000;
/** How far `at` may drift from "now" before /state treats it as a real point-in-time request
 * rather than float/clock-skew noise. Point-in-time playback itself is Milestone 10. */
const LIVE_STATE_TOLERANCE_MS = 5_000;

interface MapVersionRow {
  id: string;
  slug: string;
  name: string;
  version_number: number;
  compiled_runtime_bundle: CompiledMapBundle;
  effective_from: Date;
  effective_to: Date | null;
}

async function currentVersionForSlug(
  pool: Pool,
  slug: string,
  at: Date,
): Promise<MapVersionRow | undefined> {
  const result = await pool.query<MapVersionRow>(
    `select mv.id, m.slug, m.name, mv.version_number, mv.compiled_runtime_bundle, mv.effective_from, mv.effective_to
     from map_version mv
     join map m on m.id = mv.map_id
     where m.slug = $1 and mv.effective_from <= $2 and (mv.effective_to is null or mv.effective_to > $2)
     order by mv.effective_from desc
     limit 1`,
    [slug, at],
  );
  return result.rows[0];
}

function tdAreasFromBundle(bundle: CompiledMapBundle): string[] {
  const areas = new Set<string>();
  for (const key of Object.keys(bundle.berthBindingIndex)) {
    const area = key.split("|")[0];
    if (area) areas.add(area);
  }
  return [...areas];
}

async function liveDataStatus(
  pool: Pool,
  tdAreas: string[],
  now: Date,
): Promise<"ok" | "stale" | "unknown"> {
  if (tdAreas.length === 0) return "unknown";
  const result = await pool.query<{ last_heartbeat_at: Date }>(
    `select max(event_at) as last_heartbeat_at from td_heartbeat where td_area = any($1::text[])`,
    [tdAreas],
  );
  const lastHeartbeatAt = result.rows[0]?.last_heartbeat_at;
  if (!lastHeartbeatAt) return "unknown";
  return now.getTime() - lastHeartbeatAt.getTime() <= FRESHNESS_THRESHOLD_MS ? "ok" : "stale";
}

/** Canonical map schema + basic Lancaster renderer endpoints (docs/IMPLEMENTATION_PLAN.md
 * Milestone 5, docs/API_CONTRACT.md §1). Playback (/events, historical `at`), live WebSocket
 * push and the editor API are later milestones — not implemented here. */
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
      if (Math.abs(at.getTime() - now.getTime()) > LIVE_STATE_TOLERANCE_MS) {
        reply.code(501);
        return apiError(
          "NOT_YET_SUPPORTED",
          "Point-in-time playback state arrives in Milestone 10 — only current live state is available today.",
        );
      }

      const version = await currentVersionForSlug(pool, request.params.slug, now);
      if (!version) {
        reply.code(404);
        return apiError(
          "MAP_NOT_FOUND",
          `No published version of "${request.params.slug}" is currently effective`,
        );
      }

      const bundle = version.compiled_runtime_bundle;
      const berthKeys = Object.keys(bundle.berthBindingIndex);
      const tdAreas = berthKeys.map((key) => key.split("|")[0] ?? "");
      const berthCodes = berthKeys.map((key) => key.split("|")[1] ?? "");

      const currentStateResult = await pool.query<{
        td_area: string;
        berth_code: string;
        description: string | null;
        occupancy_entered_at: Date | null;
        source_ingestion_sequence: string;
      }>(
        `select bcs.td_area, bcs.berth_code, bcs.description, bcs.occupancy_entered_at, bcs.source_ingestion_sequence
         from berth_current_state bcs
         join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
           on wanted.td_area = bcs.td_area and wanted.berth_code = bcs.berth_code
         where bcs.projection_version = $3`,
        [tdAreas, berthCodes, TD_PROJECTION_VERSION],
      );
      const stateByKey = new Map(
        currentStateResult.rows.map((row) => [`${row.td_area}|${row.berth_code}`, row]),
      );

      let sourceSequence = 0;
      const berths: Record<
        string,
        { description: string | null; enteredAt: string | null; runSummary: null }
      > = {};
      for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
        const state = stateByKey.get(key);
        berths[elementId] = {
          description: state?.description ?? null,
          enteredAt: state?.occupancy_entered_at ? state.occupancy_entered_at.toISOString() : null,
          runSummary: null,
        };
        if (state) {
          sourceSequence = Math.max(sourceSequence, Number(state.source_ingestion_sequence));
        }
      }

      // Lancaster (and every current-scope map) has no S-Class binding — signals are always
      // blank, never computed from movements/routes/timetables (docs/PROJECT_SPEC.md §6).
      const signals: Record<string, { state: "blank" }> = {};
      for (const element of Object.values(bundle.elementsById)) {
        if (element.type === "signal") {
          signals[element.id] = { state: "blank" };
        }
      }

      const quality = {
        status: await liveDataStatus(pool, tdAreasFromBundle(bundle), now),
        gaps: [] as string[],
      };

      return {
        mapSlug: version.slug,
        mapVersion: version.version_number,
        asOf: now.toISOString(),
        sourceSequence,
        mode: "live" as const,
        quality,
        berths,
        signals,
      };
    },
  );
}
