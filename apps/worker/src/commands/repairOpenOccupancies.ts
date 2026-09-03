import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { Config } from "../config.js";

/** Don't chase a `from` step more than this far past an interval's `entered_at` — a train that
 * genuinely sat in one berth longer than this is rare (stabled units), and the `next_entered_at`
 * fallback bounds those safely. Keeps the per-interval `td_berth_event` scan short. */
const EXIT_LOOKBACK = "3 hours";

/**
 * `repair-open-occupancies` — one-shot console command (run it from the `worker` container like
 * `migrate`). Closes `berth_occupancy` intervals that were left open by the ADR 0003 regression
 * in `project-td`'s `getOpenOccupancy` (it read `berth_current_state.occupancy_id`, which Tier 3
 * leaves NULL, so every CA `from` looked empty and no `closeOccupancy` fired). Symptom: a run's
 * headcode smeared across every berth it ever visited in point-in-time playback.
 *
 * For each `(td_area, berth_code)` with more than one `left_at IS NULL` interval, every interval
 * except the most recent is closed at:
 *   1. the `event_at` of the first `td_berth_event` that stepped a train OUT of that berth after
 *      it was entered (the true exit — present for the common "lost the close, not the frame"
 *      case), else
 *   2. the `entered_at` of the next open interval for the same berth (a safe upper bound — the
 *      berth definitely wasn't showing this train once the next one arrived), else
 *   3. its own `entered_at` (zero-length; only when nothing else is known).
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
    const before = await pool.query<{ stale_rows: string; affected_berths: string }>(
      `select count(*) filter (where rn > 1)                              as stale_rows,
              count(distinct (td_area, berth_code)) filter (where rn > 1) as affected_berths
         from (
           select td_area, berth_code,
                  row_number() over (
                    partition by projection_version, td_area, berth_code
                    order by entered_at desc
                  ) as rn
             from berth_occupancy
            where projection_version = $1 and left_at is null
         ) ranked`,
      [TD_PROJECTION_VERSION],
    );
    const staleRows = Number(before.rows[0]?.stale_rows ?? "0");
    console.log(
      `repair-open-occupancies: ${staleRows} stale open interval(s) across ` +
        `${before.rows[0]?.affected_berths ?? 0} berth(s)`,
    );
    if (staleRows === 0 || dryRun) {
      if (dryRun) console.log("repair-open-occupancies: --dry-run, no changes written");
      return;
    }

    const result = await pool.query(
      `with ranked as (
         select id, entered_at, td_area, berth_code,
                lead(entered_at) over (
                  partition by projection_version, td_area, berth_code order by entered_at
                ) as next_entered_at,
                row_number() over (
                  partition by projection_version, td_area, berth_code order by entered_at desc
                ) as rn
           from berth_occupancy
          where projection_version = $1 and left_at is null
       ),
       resolved as (
         select r.id, r.entered_at, r.next_entered_at,
                x.event_at as exit_at, x.raw_event_id, x.raw_event_normalized_at_utc
           from ranked r
           left join lateral (
             select be.event_at, be.raw_event_id, be.raw_event_normalized_at_utc
               from td_berth_event be
              where be.td_area = r.td_area
                and be.from_berth = r.berth_code
                and be.event_at > r.entered_at
                and be.event_at < r.entered_at + interval '${EXIT_LOOKBACK}'
              order by be.event_at asc
              limit 1
           ) x on true
          where r.rn > 1
       )
       update berth_occupancy bo
          set left_at = coalesce(resolved.exit_at, resolved.next_entered_at, bo.entered_at),
              exit_event_id = resolved.raw_event_id,
              exit_event_normalized_at_utc = resolved.raw_event_normalized_at_utc,
              exit_reason = case when resolved.exit_at is not null
                                 then 'repaired_stepped_out'
                                 else 'repaired_no_exit_event' end
         from resolved
        where bo.id = resolved.id and bo.entered_at = resolved.entered_at`,
      [TD_PROJECTION_VERSION],
    );
    console.log(`repair-open-occupancies: closed ${result.rowCount ?? 0} interval(s)`);
  } finally {
    await pool.end();
  }
}
