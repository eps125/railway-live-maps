import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectRunLineage } from "../runLineage/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Background enrichment, not latency-sensitive (docs/adr/0007) — a 1s tick is plenty. */
const TICK_INTERVAL_MS = 1_000;

/**
 * `run-lineage-daemon` (Milestone 39, docs/adr/0007): threads an already-`resolved` run identity
 * forward along `td_berth_event` `CA` step chains and owner-curated `td_area_boundary` crossings.
 * Never establishes a run itself — `apps/api/src/routes/currentRun.ts` does that on a click.
 */
export async function runRunLineageDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 15_000 });

  console.log(`run-lineage-daemon: starting (tick ${TICK_INTERVAL_MS}ms)`);

  await runDaemonLoop({
    label: "run-lineage-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      await runProjectRunLineage(pool);
    },
    onShutdown: async () => {
      await pool.end();
    },
  });
}
