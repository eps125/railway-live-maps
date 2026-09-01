import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { apiError } from "../../lib/queryRange.js";

export interface EditorBerthActionRoutesDeps {
  pool: Pool;
}

interface ClearBerthBody {
  reason: string;
}

async function findOpenOccupancy(
  client: PoolClient,
  tdArea: string,
  berthCode: string,
): Promise<{ occupancyId: string; enteredAt: Date; description: string | null } | null> {
  // Read `berth_occupancy` directly, not `berth_current_state.occupancy_id` — since ADR 0003 the
  // fast `project-td-live` projector sets `berth_current_state.occupancy_id` to NULL, but
  // `berth_occupancy` is still fully maintained by `project-td-daemon`.
  const result = await client.query<{
    id: string;
    entered_at: Date;
    description: string | null;
  }>(
    `select id, entered_at, description
     from berth_occupancy
     where projection_version = $1 and td_area = $2 and berth_code = $3 and left_at is null
     order by entered_at desc
     limit 1`,
    [TD_PROJECTION_VERSION, tdArea, berthCode],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { occupancyId: row.id, enteredAt: row.entered_at, description: row.description };
}

/**
 * `POST /api/v1/editor/berths/{tdArea}/{berth}/clear` (private editor surface, EDITOR_ENABLED
 * gated like every other route in this directory) — a manual override for a berth stuck showing
 * a stale description, most likely because a feed connection gap silently dropped the real
 * step/clear event for it (TD is delta-only; there is no automatic backfill for a dropped
 * message). Deliberately a *live-only* override, not a fabricated feed event: it updates
 * `berth_current_state`/`berth_occupancy` directly (the same two tables
 * `apps/worker/src/td/projector.ts`'s `closeOccupancy` effect writes to) rather than inventing a
 * `raw_feed_event` row, so `project-td --rebuild` will not replay it — see
 * `operator_berth_action`'s migration comment. Every use is recorded there with a required
 * `reason`, satisfying CLAUDE.md's "do not silently repair source data."
 */
export async function registerEditorBerthActionRoutes(
  app: FastifyInstance,
  deps: EditorBerthActionRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.post<{ Params: { tdArea: string; berth: string }; Body: ClearBerthBody }>(
    "/api/v1/editor/berths/:tdArea/:berth/clear",
    async (request, reply) => {
      const { tdArea, berth } = request.params;
      const reason = request.body?.reason?.trim();
      if (!reason) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "reason (non-empty string) is required");
      }

      const client = await pool.connect();
      try {
        await client.query("begin");

        const open = await findOpenOccupancy(client, tdArea, berth);

        if (open) {
          await client.query(
            `update berth_occupancy set left_at = now(), exit_reason = 'manual_operator_clear'
             where id = $1`,
            [open.occupancyId],
          );
          await client.query(
            `update berth_current_state
             set description = null, occupancy_id = null, occupancy_entered_at = null,
                 event_at = now(), updated_at = now()
             where projection_version = $1 and td_area = $2 and berth_code = $3`,
            [TD_PROJECTION_VERSION, tdArea, berth],
          );
        }

        await client.query(
          `insert into operator_berth_action
             (td_area, berth_code, action_type, reason, closed_occupancy_id, closed_occupancy_entered_at)
           values ($1, $2, 'clear', $3, $4, $5)`,
          [tdArea, berth, reason, open?.occupancyId ?? null, open?.enteredAt ?? null],
        );

        await client.query("commit");
        return {
          tdArea,
          berth,
          cleared: open !== null,
          previousDescription: open?.description ?? null,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
