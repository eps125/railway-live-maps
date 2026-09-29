import { TD_PROJECTION_VERSION, delayBandForMovement, type DelayBand } from "@railway/domain";
import {
  advanceCheckpoint,
  ensureCheckpoint,
  getCheckpoint,
  getOrCreateProjectionDefinition,
  type Queryable,
} from "./checkpoint.js";

/**
 * Milestone 82: the public map's "Delay colours" — each TRUST train's lateness band, recorded
 * when openrail-eps reports something new (never per berth step), and read back per berth.
 *
 * Two halves:
 *  - `projectTrustDelayBands` (run by `ingest-garner` right after it mirrors TRUST): walks newly
 *    mirrored `trust_movement` rows, and appends a `trust_delay_band_change` row whenever a
 *    train's band changes.
 *  - `findMapDelaysAt` / `findOpenBerthsForTrustIds`: which mapped berths hold those trains, via
 *    RLM's own berth run links (berth_occupancy_run_link -> train_run -> trust_activation).
 */

/** Same partition-pruning bound as `currentRun.ts`'s `HISTORICAL_OCCUPANCY_LOOKBACK`: an
 * occupancy that started longer ago than this is treated as having no run, never scanned for. */
const OCCUPANCY_LOOKBACK = "24 hours";

/** How far a Change of Identity chain is followed (the popup's `fetchTrustChanges` uses the same
 * kind of cap); real chains are one hop. */
const MAX_IDENTITY_HOPS = 5;

const PROJECTION_NAME = "trust-delay-bands";
/** 2 (migration 0045, owner 2026-09-29): `on_time` split out of `none`. Bumping the version
 * gives the projection a fresh checkpoint, so it re-fills the last 24 h under the new meaning
 * after 0045 clears the version-1 rows. */
const PROJECTION_VERSION = 2;

/** A never-run projection starts this far back instead of at the beginning of the mirror — so it
 * fills in recent history for playback without grinding through every report ever mirrored. */
const FRESH_START_LOOKBACK = "24 hours";

/** Rows of `trust_movement` read per call. */
const DEFAULT_BATCH = 5_000;

/** Map-independent: a train's band now, after this batch. */
export interface TouchedTrain {
  /** The train's activation TRUST id (root of any Change of Identity chain). */
  trustId: string;
  band: DelayBand;
  /** When the report that set `band` happened (actual_timestamp). */
  reportedAt: Date | null;
}

export interface DelayBandProjectionResult {
  movementsRead: number;
  changesRecorded: number;
  /** Every train that had at least one new report in this batch, with its current band. */
  touched: TouchedTrain[];
}

interface MovementWalkRow {
  root: string;
  last_band: DelayBand | null;
  last_effective_at: Date | null;
  id: string;
  actual_timestamp: Date;
  timetable_variation: number | null;
  flags: number | null;
}

async function projectionId(pool: Queryable): Promise<string> {
  const id = await getOrCreateProjectionDefinition(
    pool,
    PROJECTION_NAME,
    PROJECTION_VERSION,
    PROJECTION_NAME,
  );
  await ensureCheckpoint(pool, id);
  return id;
}

/**
 * Processes the next batch of mirrored `trust_movement` rows (checkpointed by their RLM `id`,
 * which only `ingest-garner` assigns, in insert order). For every train they belong to, walks
 * that train's reports since its last recorded band change in report order and appends a change
 * each time the band differs — so a backlog (or the first 24 h after deploy) gets a faithful
 * history for playback, not just the final band. Idempotent: a report can cause at most one row
 * (`source_movement_id` is unique), and re-walking reports already walked emits nothing new.
 */
export async function projectTrustDelayBands(
  pool: Queryable,
  opts: { batchSize?: number } = {},
): Promise<DelayBandProjectionResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const defId = await projectionId(pool);
  const checkpoint = await getCheckpoint(pool, defId);
  let after = Number(checkpoint?.lastIngestionSequence ?? "0");

  if (after === 0 && checkpoint?.lastCompletedAt == null) {
    // Earliest report in the window by `created` (its own index), not `min(id)`: the planner
    // answers `min(id) ... where created >= X` by walking the primary key up from the oldest row,
    // which on production (~23M rows) hit the 30 s statement timeout on every tick after the
    // Milestone 82 deploy. This form takes 24 ms. Ids follow `created` closely, so starting from
    // this row's id is the same window.
    const start = await pool.query<{ first_id: string | null }>(
      `select id::text as first_id from trust_movement
       where created >= now() - $1::interval
       order by created, id
       limit 1`,
      [FRESH_START_LOOKBACK],
    );
    const firstId = start.rows[0]?.first_id;
    if (firstId == null) return { movementsRead: 0, changesRecorded: 0, touched: [] };
    after = Number(firstId) - 1;
    await advanceCheckpoint(pool, defId, String(after));
  }

  const batch = await pool.query<{ id: string; trust_id: string }>(
    `select id::text as id, trust_id from trust_movement where id > $1 order by id limit $2`,
    [after, batchSize],
  );
  if (batch.rows.length === 0) return { movementsRead: 0, changesRecorded: 0, touched: [] };
  const lastId = batch.rows[batch.rows.length - 1]!.id;
  const reportingIds = [...new Set(batch.rows.map((row) => row.trust_id))];

  // Each reporting id's activation root (walking Change of Identity links backwards), then every
  // id in each root's chain (forwards), so a train's reports under old and new ids are one walk.
  const rootsResult = await pool.query<{ trust_id: string; root: string }>(
    `with recursive up(trust_id, root, depth) as (
       select t, t, 0 from unnest($1::text[]) as t
       union all
       select up.trust_id, c.trust_id, up.depth + 1
       from up join trust_changeid c on c.new_trust_id = up.root
       where up.depth < $2
     )
     select distinct on (trust_id) trust_id, root from up order by trust_id, depth desc`,
    [reportingIds, MAX_IDENTITY_HOPS],
  );
  const roots = [...new Set(rootsResult.rows.map((row) => row.root))];

  const walk = await pool.query<MovementWalkRow>(
    `with recursive down(root, trust_id, depth) as (
       select r, r, 0 from unnest($1::text[]) as r
       union all
       select down.root, c.new_trust_id, down.depth + 1
       from down join trust_changeid c on c.trust_id = down.trust_id
       where down.depth < $2
     ),
     chains as (
       select root, array_agg(distinct trust_id) as ids from down group by root
     ),
     last as (
       select distinct on (trust_id) trust_id as root, band, effective_at
       from trust_delay_band_change
       where trust_id = any($1::text[])
       order by trust_id, effective_at desc, id desc
     )
     select c.root, last.band as last_band, last.effective_at as last_effective_at,
            m.id::text as id, m.actual_timestamp, m.timetable_variation, m.flags
     from chains c
     left join last on last.root = c.root
     join trust_movement m on m.trust_id = any(c.ids)
     where m.actual_timestamp is not null
       and (last.effective_at is null or m.actual_timestamp >= last.effective_at)
     order by c.root, m.actual_timestamp, m.created, m.id`,
    [roots, MAX_IDENTITY_HOPS],
  );

  const changes: Array<{ trustId: string; band: DelayBand; at: Date; sourceId: string }> = [];
  const current = new Map<string, TouchedTrain>();
  for (const row of walk.rows) {
    let state = current.get(row.root);
    if (!state) {
      state = {
        trustId: row.root,
        band: row.last_band ?? "none",
        reportedAt: row.last_effective_at,
      };
      current.set(row.root, state);
    }
    const band = delayBandForMovement(row.timetable_variation, row.flags);
    if (band !== state.band) {
      changes.push({ trustId: row.root, band, at: row.actual_timestamp, sourceId: row.id });
      state.band = band;
    }
    state.reportedAt = row.actual_timestamp;
  }

  let changesRecorded = 0;
  if (changes.length > 0) {
    const inserted = await pool.query<{ id: string }>(
      `insert into trust_delay_band_change (trust_id, band, effective_at, source_movement_id)
       select * from unnest($1::text[], $2::text[], $3::timestamptz[], $4::bigint[])
       on conflict (source_movement_id) do nothing
       returning id`,
      [
        changes.map((c) => c.trustId),
        changes.map((c) => c.band),
        changes.map((c) => c.at.toISOString()),
        changes.map((c) => c.sourceId),
      ],
    );
    changesRecorded = inserted.rows.length;
  }

  await advanceCheckpoint(pool, defId, lastId);
  return { movementsRead: batch.rows.length, changesRecorded, touched: [...current.values()] };
}

/** A berth whose occupancy is linked to a run, with that run's band. */
export interface BerthDelayRow {
  tdArea: string;
  berth: string;
  description: string;
  /** RLM `train_run.id` — the public key for the run (never a TRUST/CIF id). */
  runKey: string;
  matchConfidence: "solid" | "weak";
  band: DelayBand;
}

interface BerthDelaySqlRow {
  td_area: string;
  berth_code: string;
  description: string;
  run_key: string;
  match_confidence: "solid" | "weak";
  band: DelayBand;
}

function toBerthDelayRow(row: BerthDelaySqlRow): BerthDelayRow {
  return {
    tdArea: row.td_area,
    berth: row.berth_code,
    description: row.description,
    runKey: row.run_key,
    matchConfidence: row.match_confidence,
    band: row.band,
  };
}

/**
 * Every banded berth among `berths` at `at` (now for the live map, the playback clock
 * otherwise). A berth is included only when the occupancy covering `at` carries a run link
 * (solid or weak — owner, 2026-09-29; ambiguous/unmatched berths have none, so nothing is
 * guessed, CLAUDE.md rule 7), the run's schedule was activated on its traffic day (rule 6), and
 * that train's band in force at `at` is not `none`.
 *
 * Query shape checked with EXPLAIN ANALYZE on production (2026-09-29): each berth's occupancy is
 * the latest one that started at or before `at` (one index entry per berth), checked for still
 * being open only afterwards — filtering on `left_at` inside the lookup walked every occupancy of
 * the previous day per berth (5-15 s).
 */
export async function findMapDelaysAt(
  pool: Queryable,
  berths: ReadonlyArray<{ tdArea: string; berth: string }>,
  at: Date,
): Promise<BerthDelayRow[]> {
  if (berths.length === 0) return [];
  const result = await pool.query<BerthDelaySqlRow>(
    `with wanted as (
       select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code
     ),
     occ as materialized (
       select w.td_area, w.berth_code, o.description, o.id, o.entered_at
       from wanted w
       cross join lateral (
         select o.id, o.entered_at, o.description, o.left_at from berth_occupancy o
         where o.projection_version = $3 and o.td_area = w.td_area and o.berth_code = w.berth_code
           and o.entered_at <= $4::timestamptz
           and o.entered_at > $4::timestamptz - $5::interval
         order by o.entered_at desc limit 1
       ) o
       where o.left_at is null or o.left_at > $4::timestamptz
     ),
     runs as materialized (
       select occ.td_area, occ.berth_code, occ.description, r.id as run_id, r.cif_schedule_id,
              r.traffic_day, r.match_confidence
       from occ
       join berth_occupancy_run_link l
         on l.berth_occupancy_id = occ.id and l.occupancy_entered_at = occ.entered_at
       join train_run r on r.id = l.train_run_id
       where r.superseded_by is null and r.cif_schedule_id is not null
     )
     select runs.td_area, runs.berth_code, runs.description, runs.run_id::text as run_key,
            runs.match_confidence, b.band
     from runs
     cross join lateral (
       select ta.trust_id from trust_activation ta
       where ta.cif_schedule_id = runs.cif_schedule_id
         and ta.created >= (runs.traffic_day)::timestamp at time zone 'Europe/London'
         and ta.created <= $4::timestamptz
       order by ta.created desc limit 1
     ) a
     cross join lateral (
       select c.band from trust_delay_band_change c
       where c.trust_id = a.trust_id and c.effective_at <= $4::timestamptz
       order by c.effective_at desc, c.id desc limit 1
     ) b
     where b.band <> 'none'`,
    [
      berths.map((b) => b.tdArea),
      berths.map((b) => b.berth),
      TD_PROJECTION_VERSION,
      at.toISOString(),
      OCCUPANCY_LOOKBACK,
    ],
  );
  return result.rows.map(toBerthDelayRow);
}

/**
 * Which of `berths` (every berth bound on a published map) currently hold a run whose activation
 * is one of `trustIds` — the push side: after a batch of new TRUST reports, which berths to
 * re-colour. A run is matched to an activation by the same rule `findMapDelaysAt` uses (the
 * latest activation of its schedule since its traffic day began), so push and snapshot always
 * agree. `band` is the band as of now, `none` included (a push may need to take a colour away).
 *
 * Starts from the berths, not the trains (checked on production, 2026-09-29): only the few
 * dozen currently occupied mapped berths are looked at (13-364 ms for all 582 mapped berths).
 * Going from a batch's trains to their linked occupancies instead meant thousands of cold
 * per-occupancy reads (20 s), since the run-lineage sweep links every berth a train steps
 * through.
 */
export async function findOpenBerthsForTrustIds(
  pool: Queryable,
  trustIds: ReadonlyArray<string>,
  berths: ReadonlyArray<{ tdArea: string; berth: string }>,
): Promise<Array<BerthDelayRow & { trustId: string }>> {
  if (trustIds.length === 0 || berths.length === 0) return [];
  const result = await pool.query<BerthDelaySqlRow & { trust_id: string }>(
    `with wanted as (
       select unnest($2::text[]) as td_area, unnest($3::text[]) as berth_code
     ),
     cur as materialized (
       select distinct bcs.td_area, bcs.berth_code from berth_current_state bcs
       join wanted w on w.td_area = bcs.td_area and w.berth_code = bcs.berth_code
       where bcs.projection_version = $4 and bcs.description is not null
     ),
     occ as materialized (
       select cur.td_area, cur.berth_code, o.description, o.id, o.entered_at
       from cur
       cross join lateral (
         select o.id, o.entered_at, o.description, o.left_at from berth_occupancy o
         where o.projection_version = $4 and o.td_area = cur.td_area
           and o.berth_code = cur.berth_code and o.entered_at > now() - $5::interval
         order by o.entered_at desc limit 1
       ) o
       where o.left_at is null
     ),
     runs as materialized (
       select occ.td_area, occ.berth_code, occ.description, r.id as run_id, r.cif_schedule_id,
              r.traffic_day, r.match_confidence
       from occ
       join berth_occupancy_run_link l
         on l.berth_occupancy_id = occ.id and l.occupancy_entered_at = occ.entered_at
       join train_run r on r.id = l.train_run_id
       where r.superseded_by is null and r.cif_schedule_id is not null
     )
     select runs.td_area, runs.berth_code, runs.description, runs.run_id::text as run_key,
            runs.match_confidence, a.trust_id, coalesce(b.band, 'none') as band
     from runs
     cross join lateral (
       select ta.trust_id from trust_activation ta
       where ta.cif_schedule_id = runs.cif_schedule_id
         and ta.created >= (runs.traffic_day)::timestamp at time zone 'Europe/London'
       order by ta.created desc limit 1
     ) a
     left join lateral (
       select c.band from trust_delay_band_change c
       where c.trust_id = a.trust_id
       order by c.effective_at desc, c.id desc limit 1
     ) b on true
     where a.trust_id = any($1::text[])`,
    [
      trustIds,
      berths.map((b) => b.tdArea),
      berths.map((b) => b.berth),
      TD_PROJECTION_VERSION,
      OCCUPANCY_LOOKBACK,
    ],
  );
  return result.rows.map((row) => ({ ...toBerthDelayRow(row), trustId: row.trust_id }));
}
