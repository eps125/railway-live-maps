import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectTd } from "../td/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Not on the hot path any more (ADR 0003) — `project-td-live-daemon` owns `berth_current_state`
 * + delta publishing. This daemon does the heavier history/S-Class/anomaly projection, where
 * seconds of lag don't matter. 250ms tick is still plenty. */
const TICK_INTERVAL_MS = 250;

/** Cap on `runProjectTd` batches per tick (× DEFAULT_BATCH_SIZE 500 = ~10k events) so a large
 * catch-up doesn't block the loop for minutes in one call. */
const PROJECT_TD_MAX_BATCHES_PER_TICK = 20;

/**
 * `project-td-daemon` — the non-hot-path TD projector: `td_berth_event`, `berth_occupancy`
 * history, `td_s_*`, `td_area_summary`, `td_heartbeat`, anomalies. Since ADR 0003 (Milestone 16)
 * it no longer publishes the WebSocket Redis deltas — `project-td-live-daemon` does that, on a
 * much tighter loop, alongside `berth_current_state`. As of 2026-09-03 this daemon also no
 * longer writes `berth_current_state` at all: it was a third writer of that table and its
 * catch-up batches deadlocked against `ingest-td` inline + `projector-td-live` (every tick
 * failed, the history projection froze). `berth_current_state` is now solely those two's; on a
 * `--rebuild`, `projector-td-live` re-seeds it from the rebuilt `berth_occupancy`.
 *
 * `--rebuild` is not available here — run the one-shot `project-td --rebuild` command from the
 * worker console (it also resets the live projector's checkpoint), then restart both daemons.
 */
export async function runProjectTdDaemon(config: Config): Promise<void> {
  // statementTimeoutMs: nothing this daemon runs is legitimately slow, and a query hung on a
  // connection Postgres killed during its own restart would otherwise wedge the loop forever
  // (observed 2026-09-01, twice, after Postgres restarts). 15s cap → the hung query errors,
  // runDaemonLoop catches it, next tick reconnects.
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 15_000 });

  console.log(
    `project-td-daemon: starting (tick ${TICK_INTERVAL_MS}ms, history/S-Class/anomalies)`,
  );

  await runDaemonLoop({
    label: "project-td-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      await runProjectTd(pool, { maxBatches: PROJECT_TD_MAX_BATCHES_PER_TICK });
    },
    onShutdown: async () => {
      await pool.end();
    },
  });
}
