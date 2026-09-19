import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { TD_PROJECTION_VERSION, VIRTUAL_BERTH_PROJECTION_VERSION } from "@railway/domain";
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

/** `berth_current_state` can show a description with no matching open `berth_occupancy` row —
 * always for a berth whose live state came from a `NULL_DESCRIPTION` ("----") step (those never
 * open an occupancy at all, see `berthReducer.ts`), and in principle for any other
 * live/history divergence between the two independently-written tables (ADR 0003). Read directly
 * so a clear isn't silently skipped just because `findOpenOccupancy` found nothing. */
async function findCurrentDescription(
  client: PoolClient,
  tdArea: string,
  berthCode: string,
): Promise<string | null> {
  const result = await client.query<{ description: string | null }>(
    `select description
     from berth_current_state
     where projection_version = $1 and td_area = $2 and berth_code = $3`,
    [TD_PROJECTION_VERSION, tdArea, berthCode],
  );
  return result.rows[0]?.description ?? null;
}

/**
 * `POST /api/v1/editor/berths/{tdArea}/{berth}/clear` (private editor surface, role-gated like
 * every other route in this directory — Milestone 29) — a manual override for a berth stuck showing
 * a stale description, most likely because a feed connection gap silently dropped the real
 * step/clear event for it (TD is delta-only; there is no automatic backfill for a dropped
 * message), or because it's live-only state with no `berth_occupancy` row at all (a
 * `NULL_DESCRIPTION`/"----" step never opens one — see `findCurrentDescription`). Deliberately a
 * *live-only* override, not a fabricated feed event: it updates `berth_current_state`/
 * `berth_occupancy` directly (the same two tables `apps/worker/src/td/projector.ts`'s
 * `closeOccupancy` effect writes to) rather than inventing a `raw_feed_event` row, so
 * `project-td --rebuild` will not replay it — see `operator_berth_action`'s migration comment.
 * Every use is recorded there with a required `reason`, satisfying CLAUDE.md's "do not silently
 * repair source data."
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
        const current = await findCurrentDescription(client, tdArea, berth);
        const hadSomethingLive = open !== null || current !== null;

        if (open) {
          await client.query(
            `update berth_occupancy set left_at = now(), exit_reason = 'manual_operator_clear'
             where id = $1`,
            [open.occupancyId],
          );
        }
        if (hadSomethingLive) {
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
          cleared: hadSomethingLive,
          previousDescription: open?.description ?? current,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  registerVirtualBerthClearRoute(app, deps);
}

interface OpenVirtualOccupancy {
  occupancyId: string;
  enteredAt: Date;
  headcode: string | null;
  trustId: string | null;
}

async function findOpenVirtualOccupancy(
  client: PoolClient,
  stanox: string,
): Promise<OpenVirtualOccupancy | null> {
  const result = await client.query<{
    id: string;
    entered_at: Date;
    headcode: string | null;
    trust_id: string;
  }>(
    `select id, entered_at, headcode, trust_id
     from virtual_berth_occupancy
     where projection_version = $1 and stanox = $2 and left_at is null
     order by entered_at desc
     limit 1`,
    [VIRTUAL_BERTH_PROJECTION_VERSION, stanox],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    occupancyId: row.id,
    enteredAt: row.entered_at,
    headcode: row.headcode,
    trustId: row.trust_id,
  };
}

/**
 * `POST /api/v1/editor/virtual-berths/{stanox}/clear` (docs/adr/0012 gap closure, owner request
 * 2026-09-19) — the virtual-berth equivalent of the TD manual clear above, for exactly the same
 * reason: a virtual berth has no automatic hand-off back to a "definitely vacant" state the way a
 * TD berth's CB/CC does, so its owning train's GPS reporting going permanently quiet mid-journey
 * (a device fault, a dead zone with no further reports ever) would otherwise leave it stuck
 * showing occupied forever with no operator escape hatch at all. Live-only override, same as the
 * TD route: updates `virtual_berth_current_state`/`virtual_berth_occupancy` directly rather than
 * fabricating a `trust_movement` row, so `project-virtual-berths --rebuild` never replays it.
 * Logged in the same `operator_berth_action` audit trail (migration 0036 widened it to cover
 * this), required `reason` included.
 */
function registerVirtualBerthClearRoute(
  app: FastifyInstance,
  deps: EditorBerthActionRoutesDeps,
): void {
  const { pool } = deps;

  app.post<{ Params: { stanox: string }; Body: ClearBerthBody }>(
    "/api/v1/editor/virtual-berths/:stanox/clear",
    async (request, reply) => {
      const { stanox } = request.params;
      const reason = request.body?.reason?.trim();
      if (!reason) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "reason (non-empty string) is required");
      }

      const client = await pool.connect();
      try {
        await client.query("begin");

        const open = await findOpenVirtualOccupancy(client, stanox);

        if (open) {
          await client.query(
            `update virtual_berth_occupancy set left_at = now(), exit_reason = 'manual_clear'
             where id = $1`,
            [open.occupancyId],
          );
        }
        await client.query(
          `update virtual_berth_current_state
           set trust_id = null, headcode = null, occupancy_id = null, occupancy_entered_at = null,
               event_at = now(), updated_at = now()
           where projection_version = $1 and stanox = $2`,
          [VIRTUAL_BERTH_PROJECTION_VERSION, stanox],
        );

        await client.query(
          `insert into operator_berth_action
             (stanox, action_type, reason, closed_virtual_occupancy_id, closed_virtual_occupancy_entered_at)
           values ($1, 'clear', $2, $3, $4)`,
          [stanox, reason, open?.occupancyId ?? null, open?.enteredAt ?? null],
        );

        await client.query("commit");
        return {
          stanox,
          cleared: open !== null,
          previousHeadcode: open?.headcode ?? null,
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
