import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectTdLive } from "../td/liveProjector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** The hot path ticks fast — the whole point is sub-second end-to-end (ADR 0003). Each tick is
 * one small `raw_feed_event` read + one bulk `berth_current_state` upsert + a few Redis
 * publishes, so 100ms is comfortable. */
const TICK_INTERVAL_MS = 100;

/** Cap per tick so a large catch-up doesn't block the loop (same reasoning as project-td-daemon's
 * maxBatches). 30 × 100 = 3000 events/tick. */
const MAX_BATCHES_PER_TICK = 30;

/**
 * `project-td-live-daemon` (ADR 0003 / Milestone 16) — the dedicated fast path that keeps
 * `berth_current_state` current in real time and publishes the WebSocket layer's Redis deltas.
 * Everything else (td_berth_event, berth_occupancy history, S-Class, anomalies, td_area_summary)
 * stays on `project-td-daemon`, which no longer publishes deltas.
 *
 * Requires `LIVE_WS_REDIS_PUBSUB_ENABLED` for the delta publish; without it this still keeps
 * `berth_current_state` fresh (the API's polling delta source reads that) but publishes nothing.
 */
export async function runProjectTdLiveDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 10_000 });
  const redis = config.LIVE_WS_REDIS_PUBSUB_ENABLED
    ? new Redis(config.REDIS_URL, {
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
    : null;

  console.log(
    `project-td-live-daemon: starting (tick ${TICK_INTERVAL_MS}ms, ` +
      `deltas ${redis ? "enabled" : "disabled"})`,
  );

  await runDaemonLoop({
    label: "project-td-live-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      await runProjectTdLive(pool, redis, { maxBatches: MAX_BATCHES_PER_TICK });
    },
    onShutdown: async () => {
      redis?.disconnect();
      await pool.end();
    },
  });
}
