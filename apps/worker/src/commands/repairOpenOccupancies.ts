import { setTimeout as sleep } from "node:timers/promises";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { Config } from "../config.js";

/** Don't chase an interval's closing event more than this far past its `entered_at`. A stale
 * trail's step-out is within seconds/minutes; a genuine current occupant has no closing event
 * at all, so the per-interval `td_berth_event` scan runs the whole window fruitlessly — keep it
 * short. A berth held longer than this by a real train stays open (rare; acceptable). */
const CLOSE_LOOKBACK = "90 minutes";

/** Rows per batch. Small on purpose: each batch's UPDATE runs one `td_berth_event` lateral scan
 * per row, and for a still-occupied berth that scan finds nothing and reads the whole
 * `CLOSE_LOOKBACK` window — a large batch of those blew the 120s statement timeout (2026-09-03,
 * 7,899 mostly-current-occupant intervals in one batch). */
const BATCH_SIZE = 400;

/** Pause between batches so a concurrently-running `projector-td` (if it wasn't stopped) gets
 * turns. Even so, prefer stopping `projector-td` for the duration — see the doc comment. */
const BATCH_PAUSE_MS = 20;

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
 * the first thing that removed a train from that berth after it was entered — and close there:
 *   - `from_berth` match  → `repaired_stepped_out`  (a CA stepped the train on)
 *   - `to_berth` match     → `repaired_overwritten`  (a later CA/CC put a new train in)
 *   - CB `from_berth` match → `repaired_cancelled`
 * If none exists the interval is genuinely still the berth's current occupant (or the closing
 * frame was lost) and is left open.
 *
 * Processes in `id`-keyset batches so a multi-million-row backlog doesn't lock the table in one
 * transaction. Idempotent (a closed interval is no longer `left_at IS NULL`; keyset only moves
 * forward). **Stop the `projector-td` service for the duration** — it writes the same rows and a
 * concurrent big write here deadlocked against it (2026-09-03). Then deploy the `getOpenOccupancy`
 * fix, run this, restart `projector-td`. Does not touch `td_projection_anomaly` (harmless audit
 * rows) or `berth_current_state` (the live map reads `description`, which was always correct).
 *
 * `--dry-run` reports the open-interval count only (no scan of what would close).
 */
export async function runRepairOpenOccupancies(config: Config, argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 120_000 });
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
      console.log("repair-open-occupancies: --dry-run, no changes written");
      return;
    }

    let afterId = "0";
    let scanned = 0;
    let closed = 0;
    let batchNo = 0;

    for (;;) {
      const keys = await pool.query<{ id: string }>(
        `select id::text
           from berth_occupancy
          where projection_version = $1 and left_at is null and id > $2
          order by id
          limit $3`,
        [TD_PROJECTION_VERSION, afterId, BATCH_SIZE],
      );
      if (keys.rows.length === 0) break;
      afterId = keys.rows[keys.rows.length - 1]!.id;
      scanned += keys.rows.length;
      batchNo += 1;
      const ids = keys.rows.map((row) => row.id);

      const runBatch = (): Promise<{ rowCount: number | null }> =>
        pool.query(
          `with closing as (
           select o.id, o.entered_at,
                  x.event_at, x.message_type, (x.by_from) as by_from,
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
            where o.id = any($1::bigint[]) and o.left_at is null
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
          [ids],
        );

      // Retry a batch on deadlock (40P01) or statement timeout (57014) — both are transient at
      // the batch level. After 3 retries, log the id range and move on rather than aborting the
      // whole run; a re-run picks up whatever was skipped (idempotent, keyset-forward).
      let updated: { rowCount: number | null } | undefined;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          updated = await runBatch();
          break;
        } catch (error) {
          const code = (error as { code?: string }).code;
          const retryable = code === "40P01" || code === "57014";
          if (retryable && attempt < 4) {
            console.warn(
              `repair-open-occupancies: batch ${batchNo} failed (${code}, attempt ${attempt}), retrying`,
            );
            await sleep(500 * attempt);
            continue;
          }
          if (retryable) {
            console.error(
              `repair-open-occupancies: batch ${batchNo} (ids ${ids[0]}..${ids[ids.length - 1]}) ` +
                `still failing (${code}) after ${attempt} attempts — skipping; re-run to retry it`,
            );
            break;
          }
          throw error;
        }
      }
      closed += updated?.rowCount ?? 0;

      if (batchNo % 25 === 0) {
        console.log(
          `repair-open-occupancies: batch ${batchNo} — scanned ${scanned}, closed ${closed}`,
        );
      }
      await sleep(BATCH_PAUSE_MS);
    }

    console.log(
      `repair-open-occupancies: done — scanned ${scanned} open interval(s), closed ${closed} ` +
        "(the rest have no later berth event and stay open)",
    );
  } finally {
    await pool.end();
  }
}
