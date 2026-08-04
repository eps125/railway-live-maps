import { createPool, ensureMonthlyPartitions } from "@railway/database";
import type { Config } from "../config.js";

/** The three tables partitioned per docs/DATA_MODEL.md §11 that need ongoing month top-up. */
const PARTITIONED_TABLES = ["raw_feed_event", "td_berth_event", "td_s_event"] as const;

/** Shared by the standalone `ensure-partitions` command and `migrate` (which tops up
 * partitions right after applying migrations, so every release stays ahead of the default
 * partition). */
export async function ensureAllPartitions(
  pool: ReturnType<typeof createPool>,
  config: Config,
): Promise<void> {
  for (const parentTable of PARTITIONED_TABLES) {
    const result = await ensureMonthlyPartitions(
      pool,
      { parentTable },
      { monthsAhead: config.PARTITION_MONTHS_AHEAD },
    );
    console.log(
      result.created.length > 0
        ? `${parentTable}: created ${result.created.join(", ")}`
        : `${parentTable}: all partitions already existed`,
    );
  }
}

export async function runEnsurePartitions(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    await ensureAllPartitions(pool, config);
  } finally {
    await pool.end();
  }
}
