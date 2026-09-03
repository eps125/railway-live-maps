import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { Config } from "../config.js";

/** Don't chase an interval's closing event more than this far past its `entered_at`. A train
 * that genuinely sat in one berth longer than this is rare (stabled units) and its interval is
 * legitimately still open, so leave it. Keeps the per-interval `td_berth_event` scan short. */
const CLOSE_LOOKBACK = "6 hours";

/**
 * `repair-open-occupancies` — one-shot console command (run it from the `worker` container like
 * `migrate`; no new container). Closes `berth_occupancy` intervals that were left open by the
 * ADR 0003 regression in `project-td`'s `getOpenOccupancy` (it read
 * `berth_current_state.occupancy_id`, which Tier 3 leaves NULL, so every CA `from` looked empty
 * and no `closeOccupancy` fired). Symptom: a run's headcode smeared across every berth it ever
 * visited in point-in-time playback.
 *
 * For each interval with `left_at IS NULL`, find the earliest `td_berth_event` for that
 * `(td_area, berth_code)` (matching `from_berth` OR `to_berth`) with `event_at > entered_at` —
 * the first thing that removed a train from that berth after it was entered. If one exists,
 * close the interval there:
 *   - `from_berth` match  → `repaired_stepped_out`  (a CA stepped the train on)
 *   - `to_berth` match     → `repaired_overwritten`  (a later CA/CC put a new train in)
 *   - CB `from_berth` match → `repaired_cancelled`
 * If none exists the interval is genuinely still the berth's current occupant (or the closing
 * frame was lost — nothing to key off), so it is left open.
 *
 * Idempotent (a closed interval is no longer `left_at IS NULL`). Deploy the `getOpenOccupancy`
 * fix first, then ideally stop the `projector-td` service, run this, and restart it. Does not
 * touch `td_projection_anomaly` (the `from_berth_empty` rows are harmless audit noise) or
 * `berth_current_state` (the live map reads `description`, which was always correct).
 *
 * `--dry-run` reports the counts without writing.
 */
export async function runRepairOpenOccupancies(config: Config, argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const before = await pool.query<{ open_rows: string; berths: string }>(
      `select count(*)                              as open_rows,
              count(distinct (td_area, berth_code)) as berths
         from berth_occupancy
        where projection_version = $1 and left_at is null`,
      [TD_PROJECTION_VERSION],
    );
    console.log(
      `repair-open-occupancies: ${before.rows[0]?.open_rows ?? 0} open interval(s) across ` +
        `${before.rows[0]?.berths ?? 0} berth(s)`,
    );

    if (dryRun) {
      const preview = await pool.query<{ closeable: string }>(
        `select count(*) as closeable
           from berth_occupancy o
          where o.projection_version = $1 and o.left_at is null
            and exists (
              select 1 from td_berth_event be
               where be.td_area = o.td_area
                 and be.event_at > o.entered_at
                 and be.event_at < o.entered_at + interval '${CLOSE_LOOKBACK}'
                 and (be.from_berth = o.berth_code or be.to_berth = o.berth_code)
            )`,
        [TD_PROJECTION_VERSION],
      );
      console.log(
        `repair-open-occupancies: --dry-run — ${preview.rows[0]?.closeable ?? 0} would be closed, ` +
          "no changes written",
      );
      return;
    }

    const result = await pool.query(
      `with closing as (
         select o.id, o.entered_at,
                x.event_at, x.message_type, x.by_from,
                x.raw_event_id, x.raw_event_normalized_at_utc
           from berth_occupancy o
           join lateral (
             select be.event_at, be.message_type,
                    (be.from_berth = o.berth_code) as by_from,
                    be.raw_event_id, be.raw_event_normalized_at_utc
               from td_berth_event be
              where be.td_area = o.td_area
                and be.event_at > o.entered_at
                and be.event_at < o.entered_at + interval '${CLOSE_LOOKBACK}'
                and (be.from_berth = o.berth_code or be.to_berth = o.berth_code)
              order by be.event_at asc
              limit 1
           ) x on true
          where o.projection_version = $1 and o.left_at is null
       )
       update berth_occupancy bo
          set left_at = closing.event_at,
              exit_event_id = closing.raw_event_id,
              exit_event_normalized_at_utc = closing.raw_event_normalized_at_utc,
              exit_reason = case
                              when closing.message_type = 'CB' then 'repaired_cancelled'
                              when closing.by_from then 'repaired_stepped_out'
                              else 'repaired_overwritten'
                            end
         from closing
        where bo.id = closing.id and bo.entered_at = closing.entered_at`,
      [TD_PROJECTION_VERSION],
    );
    console.log(`repair-open-occupancies: closed ${result.rowCount ?? 0} interval(s)`);
  } finally {
    await pool.end();
  }
}
