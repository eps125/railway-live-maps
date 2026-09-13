import type { Pool } from "pg";
import { TD_PROJECTION_VERSION, confidenceForBasis, isSameRunIdentity } from "@railway/domain";

/**
 * Milestone 39 (docs/adr/0007): the `currentRun.ts` side of sticky run-lineage matching. Two
 * jobs, both additive to the existing ADR 0006/0035 resolver:
 *
 *  - `findOccupancyAndLink` — read, first: does the berth's currently open occupancy already have
 *    a run link (established earlier by a click here, or inherited by `run-lineage-daemon` from a
 *    berth this train physically stepped from)? If so, `currentRun.ts` skips headcode/position
 *    resolution entirely and uses the linked schedule directly.
 *  - `upsertResolvedLink` — write, after: whenever the existing resolver reaches a real `matched`
 *    result (never called for a lineage-shortcut match — see currentRun.ts — that would relabel an
 *    inherited link's provenance as `resolved`, losing the fact it was actually inherited),
 *    establish or correct the link so a later physical step can carry it forward.
 */

export interface OpenOccupancyRef {
  id: string;
  enteredAt: Date;
}

export interface OccupancyLink {
  trainRunId: string;
  cifScheduleId: string | null;
  cifTrainUid: string;
  trafficDay: string;
  matchBasis: "step_chain" | "boundary_correlated" | string;
  matchConfidence: "solid" | "weak";
}

export async function findOpenOccupancy(
  pool: Pool,
  tdArea: string,
  berth: string,
): Promise<OpenOccupancyRef | null> {
  const result = await pool.query<{ id: string; entered_at: Date }>(
    `select id, entered_at from berth_occupancy
     where projection_version = $1 and td_area = $2 and berth_code = $3 and left_at is null
     order by entered_at desc limit 1`,
    [TD_PROJECTION_VERSION, tdArea, berth],
  );
  const row = result.rows[0];
  return row ? { id: row.id, enteredAt: row.entered_at } : null;
}

/** Only ever returns a link to a *current* (non-superseded) run — `upsertResolvedLink` always
 * repoints the link itself when superseding, so this filter is defence in depth, not the primary
 * mechanism. */
export async function findOccupancyLink(
  pool: Pool,
  occupancy: OpenOccupancyRef,
): Promise<OccupancyLink | null> {
  const result = await pool.query<{
    train_run_id: string;
    cif_schedule_id: string | null;
    cif_train_uid: string;
    traffic_day: string;
    match_basis: string;
    match_confidence: "solid" | "weak";
  }>(
    `select l.train_run_id, r.cif_schedule_id::text as cif_schedule_id, r.cif_train_uid,
            r.traffic_day::text as traffic_day, r.match_basis, r.match_confidence
     from berth_occupancy_run_link l
     join train_run r on r.id = l.train_run_id
     where l.berth_occupancy_id = $1 and l.occupancy_entered_at = $2 and r.superseded_by is null`,
    [occupancy.id, occupancy.enteredAt],
  );
  const row = result.rows[0];
  return row
    ? {
        trainRunId: row.train_run_id,
        cifScheduleId: row.cif_schedule_id,
        cifTrainUid: row.cif_train_uid,
        trafficDay: row.traffic_day,
        matchBasis: row.match_basis,
        matchConfidence: row.match_confidence,
      }
    : null;
}

export interface ResolvedRunToLink {
  cifScheduleId: string;
  cifTrainUid: string;
  trafficDay: string;
  matchBasis: "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only";
  tdArea: string;
  berth: string;
}

/** Establishes (or corrects) the `resolved` link for `occupancy`. A no-op if it already points at
 * the same physical run; supersedes the old `train_run` row and repoints the link if it points at
 * a genuinely different one — correction, not silent drift (docs/adr/0007). */
export async function upsertResolvedLink(
  pool: Pool,
  occupancy: OpenOccupancyRef,
  resolved: ResolvedRunToLink,
): Promise<void> {
  const existing = await findOccupancyLink(pool, occupancy);
  if (
    existing &&
    existing.cifScheduleId !== null &&
    isSameRunIdentity(
      {
        cifScheduleId: existing.cifScheduleId,
        cifTrainUid: existing.cifTrainUid,
        trafficDay: existing.trafficDay,
      },
      {
        cifScheduleId: resolved.cifScheduleId,
        cifTrainUid: resolved.cifTrainUid,
        trafficDay: resolved.trafficDay,
      },
    )
  ) {
    return; // Already correctly linked — nothing to do.
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    if (existing) {
      // One round trip: insert the corrected run, then mark the old one superseded by it —
      // a data-modifying CTE, not a scalar subquery (Postgres doesn't allow INSERT there).
      const result = await client.query<{ new_run_id: string }>(
        `with new_run as (
           insert into train_run (
             cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
             established_td_area, established_berth
           ) values ($1, $2, $3::date, $4, $5, $6, $7)
           returning id
         )
         update train_run set superseded_by = new_run.id
         from new_run
         where train_run.id = $8
         returning new_run.id as new_run_id`,
        [
          resolved.cifScheduleId,
          resolved.cifTrainUid,
          resolved.trafficDay,
          resolved.matchBasis,
          confidenceForBasis(resolved.matchBasis),
          resolved.tdArea,
          resolved.berth,
          existing.trainRunId,
        ],
      );
      const newRunId = result.rows[0]!.new_run_id;
      await client.query(
        `update berth_occupancy_run_link
         set train_run_id = $1, link_basis = 'resolved', updated_at = now()
         where berth_occupancy_id = $2 and occupancy_entered_at = $3`,
        [newRunId, occupancy.id, occupancy.enteredAt],
      );
    } else {
      const runResult = await client.query<{ id: string }>(
        `insert into train_run (
           cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
           established_td_area, established_berth
         ) values ($1, $2, $3::date, $4, $5, $6, $7)
         returning id`,
        [
          resolved.cifScheduleId,
          resolved.cifTrainUid,
          resolved.trafficDay,
          resolved.matchBasis,
          confidenceForBasis(resolved.matchBasis),
          resolved.tdArea,
          resolved.berth,
        ],
      );
      await client.query(
        `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
         values ($1, $2, $3, 'resolved')`,
        [occupancy.id, occupancy.enteredAt, runResult.rows[0]!.id],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
