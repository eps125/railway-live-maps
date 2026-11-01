import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { Queryable } from "./checkpoint.js";
import type { ResolvedRunToLink } from "./runResolution.js";

/**
 * ADR 0008 amendment (2026-10-31): run links a day out. A train set up in its berth before
 * midnight for a departure after it is linked to the earlier day's run — the resolver probes only
 * today and yesterday — and the link then stays (owner report: CL 0305 092N08 stood from 23:24 on
 * the 28th, linked to the 28th's run, booked away 05:52 on the 29th). The mismatch is exact: the
 * activation the run is paired with (the newest since its traffic day began, as the delay colours
 * and held-train estimates pair it) carries another day in its TRUST ID.
 */

/** Same bound as the held-train sweep: an occupancy older than this is never looked at. */
const OCCUPANCY_LOOKBACK = "24 hours";

export interface DayMismatchedLink {
  occupancyId: string;
  enteredAt: Date;
  tdArea: string;
  berth: string;
  description: string;
  trainRunId: string;
  cifScheduleId: string;
  cifTrainUid: string;
  /** `YYYY-MM-DD`: the linked run's traffic day. */
  trafficDay: string;
  /** The activation paired with the run, whose TRUST ID names another day. */
  trustId: string;
  activatedAt: Date;
}

/**
 * Open occupancies (in `areas`, or every area when `null`) whose linked run is paired with an
 * activation for a different day. Starts from the occupied berths, one index entry per berth, like
 * `findHeldTrainCandidates`.
 */
export async function findDayMismatchedOpenLinks(
  db: Queryable,
  areas: readonly string[] | null,
  limit: number,
): Promise<DayMismatchedLink[]> {
  const { rows } = await db.query<{
    occupancy_id: string;
    entered_at: Date;
    td_area: string;
    berth_code: string;
    description: string;
    train_run_id: string;
    cif_schedule_id: string;
    cif_train_uid: string;
    traffic_day: string;
    trust_id: string;
    activated_at: Date;
  }>(
    `with cur as materialized (
       select bcs.td_area, bcs.berth_code from berth_current_state bcs
       where bcs.projection_version = $1 and bcs.description is not null
         and ($2::text[] is null or bcs.td_area = any($2::text[]))
     ),
     occ as materialized (
       select cur.td_area, cur.berth_code, o.description, o.id, o.entered_at
       from cur
       cross join lateral (
         select o.id, o.entered_at, o.description, o.left_at from berth_occupancy o
         where o.projection_version = $1 and o.td_area = cur.td_area
           and o.berth_code = cur.berth_code and o.entered_at > now() - $3::interval
         order by o.entered_at desc limit 1
       ) o
       where o.left_at is null
     ),
     runs as materialized (
       select occ.*, r.id as run_id, r.cif_schedule_id, r.cif_train_uid, r.traffic_day
       from occ
       join berth_occupancy_run_link l
         on l.berth_occupancy_id = occ.id and l.occupancy_entered_at = occ.entered_at
       join train_run r on r.id = l.train_run_id
       where r.superseded_by is null and r.cif_schedule_id is not null
     )
     select runs.id::text as occupancy_id, runs.entered_at, runs.td_area, runs.berth_code,
            runs.description, runs.run_id::text as train_run_id,
            runs.cif_schedule_id::text as cif_schedule_id, runs.cif_train_uid,
            runs.traffic_day::text as traffic_day, a.trust_id, a.created as activated_at
     from runs
     cross join lateral (
       select ta.trust_id, ta.created from trust_activation ta
       where ta.cif_schedule_id = runs.cif_schedule_id
         and ta.created >= (runs.traffic_day)::timestamp at time zone 'Europe/London'
       order by ta.created desc limit 1
     ) a
     where right(a.trust_id, 2) ~ '^[0-9]{2}$'
       and right(a.trust_id, 2)::int <> extract(day from runs.traffic_day)::int
     limit $4`,
    [TD_PROJECTION_VERSION, areas ? [...areas] : null, OCCUPANCY_LOOKBACK, limit],
  );
  return rows.map((row) => ({
    occupancyId: row.occupancy_id,
    enteredAt: row.entered_at,
    tdArea: row.td_area,
    berth: row.berth_code,
    description: row.description,
    trainRunId: row.train_run_id,
    cifScheduleId: row.cif_schedule_id,
    cifTrainUid: row.cif_train_uid,
    trafficDay: row.traffic_day,
    trustId: row.trust_id,
    activatedAt: row.activated_at,
  }));
}

/**
 * Moves one occupancy's link from `link.trainRunId` to the live run of the same schedule on
 * `resolved.trafficDay` (reused, or created), and records the move in `run_link_day_correction`.
 * Unlike `upsertResolvedLink` it never supersedes the old run: that run was a real train on its
 * own day and keeps the rest of its journey. Only this link changes (later steps inherit the new
 * run by step chain). Does nothing, and returns `null`, if the link has changed meanwhile.
 */
export async function repointLinkToRunDay(
  pool: Pool,
  link: DayMismatchedLink,
  resolved: ResolvedRunToLink,
): Promise<{ newTrainRunId: string; newRunCreated: boolean } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Same lock and reuse rule as `upsertResolvedLink`: one run per real train.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `train_run|${resolved.cifScheduleId}|${resolved.cifTrainUid}|${resolved.trafficDay}`,
    ]);
    const live = await client.query<{ id: string }>(
      `select id::text as id from train_run
        where cif_schedule_id = $1 and cif_train_uid = $2 and traffic_day = $3::date
          and superseded_by is null
        order by id desc limit 1`,
      [resolved.cifScheduleId, resolved.cifTrainUid, resolved.trafficDay],
    );
    let newTrainRunId = live.rows[0]?.id;
    const newRunCreated = newTrainRunId === undefined;
    if (newTrainRunId === undefined) {
      const inserted = await client.query<{ id: string }>(
        `insert into train_run (
           cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
           established_td_area, established_berth
         ) values ($1, $2, $3::date, $4, $5, $6, $7)
         returning id::text as id`,
        [
          resolved.cifScheduleId,
          resolved.cifTrainUid,
          resolved.trafficDay,
          resolved.matchBasis,
          resolved.matchConfidence,
          resolved.tdArea,
          resolved.berth,
        ],
      );
      newTrainRunId = inserted.rows[0]!.id;
    }
    const updated = await client.query(
      `update berth_occupancy_run_link set train_run_id = $3, link_basis = 'resolved',
              updated_at = now()
        where berth_occupancy_id = $1 and occupancy_entered_at = $2 and train_run_id = $4`,
      [link.occupancyId, link.enteredAt, newTrainRunId, link.trainRunId],
    );
    if (updated.rowCount !== 1) {
      await client.query("rollback");
      return null;
    }
    await client.query(
      `insert into run_link_day_correction (
         berth_occupancy_id, occupancy_entered_at, td_area, berth_code, description,
         old_train_run_id, new_train_run_id, new_run_created, old_traffic_day, new_traffic_day,
         cif_schedule_id, trust_id, match_basis
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12, $13)`,
      [
        link.occupancyId,
        link.enteredAt,
        link.tdArea,
        link.berth,
        link.description,
        link.trainRunId,
        newTrainRunId,
        newRunCreated,
        link.trafficDay,
        resolved.trafficDay,
        resolved.cifScheduleId,
        link.trustId,
        resolved.matchBasis,
      ],
    );
    await client.query("commit");
    return { newTrainRunId, newRunCreated };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
