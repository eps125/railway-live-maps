import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectTd } from "../td/projector.js";
import { runProjectMapDeltas } from "../mapProjector/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Well under the old `projector-td`/`map-deltas` services' 1s `sleep` + ~0.5-1s node cold start
 * per cycle — safe to go this low precisely because there's no per-tick process-start cost left
 * to pay (see runDaemonLoop's doc comment). */
const TICK_INTERVAL_MS = 250;

/** Cap on `runProjectTd` batches per tick (× DEFAULT_BATCH_SIZE 500 = ~10k events). Without it,
 * a large catch-up (e.g. the ~95k-event / 18-min backlog after the 2026-09-01 incident) runs
 * `runProjectTd` for minutes in one call, during which `runProjectMapDeltas` below never gets a
 * turn — so the WS delta stream goes silent and the live map "sticks" until F5. With the cap the
 * two interleave: the map keeps flowing deltas even while berth history catches up. */
const PROJECT_TD_MAX_BATCHES_PER_TICK = 20;

/**
 * `project-td-daemon` — long-running replacement for the `projector-td` and `map-deltas`
 * Portainer services (2026-09 live-path hardening, docs/IMPLEMENTATION_PLAN.md). Each tick runs
 * `runProjectTd` (catch-up berth position/history projection) then, if
 * `LIVE_WS_REDIS_PUBSUB_ENABLED`, `runProjectMapDeltas` (publish the resulting deltas) —
 * back to back in one process on one warm connection pool, so the two can never independently
 * drift apart into two separate sources of lag the way two unsynchronized `sleep 1` loops could.
 * A Redis publish failure is logged and does not prevent `runProjectTd` from continuing on the
 * next tick — the delta is simply re-derivable next time `runProjectMapDeltas` succeeds (its own
 * "at-least-once" design, see mapProjector/projector.ts's doc comment).
 *
 * `--rebuild` is not available here — run the one-shot `project-td --rebuild` command from the
 * worker console, then restart this daemon to resume live tailing from the rebuilt checkpoint.
 */
export async function runProjectTdDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  // Same fail-fast connection settings as the old one-shot project-map-deltas command — a daemon
  // that never gives up retrying a down Redis would otherwise mask the outage in its own logs.
  const redis = config.LIVE_WS_REDIS_PUBSUB_ENABLED
    ? new Redis(config.REDIS_URL, {
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
    : null;

  console.log(
    `project-td-daemon: starting (tick ${TICK_INTERVAL_MS}ms, map-deltas ${redis ? "enabled" : "disabled"})`,
  );

  await runDaemonLoop({
    label: "project-td-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      await runProjectTd(pool, { maxBatches: PROJECT_TD_MAX_BATCHES_PER_TICK });
      if (redis) {
        await runProjectMapDeltas(pool, redis);
      }
    },
    onShutdown: async () => {
      redis?.disconnect();
      await pool.end();
    },
  });
}
