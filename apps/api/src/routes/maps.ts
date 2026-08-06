import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { CompiledMapBundle } from "@railway/map-schema";
import { apiError } from "../lib/queryRange.js";
import { currentVersionForSlug, tdAreasFromBundle, liveDataStatus } from "../lib/mapVersion.js";
import { computeLiveState } from "../lib/liveState.js";

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
 * rather than float/clock-skew noise. Point-in-time playback itself is Milestone 10. */
const LIVE_STATE_TOLERANCE_MS = 5_000;

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

      const { sourceSequence, berths, signals, quality } = await computeLiveState(
        pool,
        version.compiled_runtime_bundle,
        now,
      );

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
