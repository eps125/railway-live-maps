import { createPool } from "@railway/database";
import type { Config } from "../config.js";

/**
 * `backfill-td-area-summary` — one-shot. Migration 0023 added `td_area_summary`, maintained
 * incrementally by `project-td` from here on; this populates it once for history that predates
 * the migration by running the exact full `raw_feed_event` scan the table exists to stop paying
 * repeatedly (docs/IMPLEMENTATION_PLAN.md's live-path-hardening milestone). Sets absolute totals
 * (not additive), so **stop the `projector-td` service before running this** — if project-td's
 * own incremental upserts race with this backfill's full recount, the two can interleave
 * inconsistently. Safe to re-run once caught up (idempotent: recomputes the same true totals).
 */
export async function runBackfillTdAreaSummary(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const result = await pool.query(
      `insert into td_area_summary (td_area, first_event_at, last_event_at, c_class_count, s_class_count, updated_at)
       select td_area,
              min(normalized_event_at_utc) as first_event_at,
              max(normalized_event_at_utc) as last_event_at,
              count(*) filter (where message_class = 'C') as c_class_count,
              count(*) filter (where message_class = 'S') as s_class_count,
              now()
       from raw_feed_event
       where feed_name = 'TD' and td_area is not null
       group by td_area
       on conflict (td_area) do update set
         first_event_at = excluded.first_event_at,
         last_event_at = excluded.last_event_at,
         c_class_count = excluded.c_class_count,
         s_class_count = excluded.s_class_count,
         updated_at = now()`,
    );
    console.log(`backfill-td-area-summary: upserted ${result.rowCount ?? 0} area row(s)`);
  } finally {
    await pool.end();
  }
}
