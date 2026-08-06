import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { compileMapDocument } from "@railway/map-schema";
import { apiError } from "../../lib/queryRange.js";
import { computeLiveState } from "../../lib/liveState.js";
import { getDraft } from "../../editor/draftStore.js";

export interface EditorStateRoutesDeps {
  pool: Pool;
}

/** How far `at` may drift from "now" before this is treated as a real historical request
 * rather than clock-skew noise — same tolerance as `routes/maps.ts`'s `/state` stub. */
const LIVE_STATE_TOLERANCE_MS = 5_000;

/**
 * `GET /api/v1/editor/state/{slug}?at=` (docs/API_CONTRACT.md §4) — backs the editor's Test
 * mode "live" and "historical" states (docs/MAP_EDITOR_SPEC.md §10). Unlike the public
 * `/maps/:slug/state`, this computes state for the DRAFT's current bindings (compiled on the
 * fly — a draft has no `map_version_id`/`map_binding_index` row, since it isn't published),
 * not a stored `compiled_runtime_bundle`.
 *
 * Historical (`at` outside the live tolerance window) is explicitly deferred:
 * docs/IMPLEMENTATION_PLAN.md's Milestone 12 note says outright "the 'historical' test mode is
 * the one piece that wants M10 (playback) — stub or defer just that part until M10 actually
 * lands" — this mirrors `routes/maps.ts`'s existing `/state` 501 stub exactly, not a new gap.
 */
export async function registerEditorStateRoutes(
  app: FastifyInstance,
  deps: EditorStateRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { slug: string }; Querystring: { at?: string } }>(
    "/api/v1/editor/state/:slug",
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
          "Historical draft test-mode state arrives in Milestone 10 — only current live state is available today.",
        );
      }

      const draft = await getDraft(pool, request.params.slug);
      if (!draft) {
        reply.code(404);
        return apiError("DRAFT_NOT_FOUND", `No draft exists for "${request.params.slug}" yet`);
      }

      const bundle = compileMapDocument(draft.canonical_document);
      const { sourceSequence, berths, signals, quality } = await computeLiveState(
        pool,
        bundle,
        now,
      );

      return {
        slug: request.params.slug,
        draftRevision: draft.revision,
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
