import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectMapDeltas } from "../mapProjector/projector.js";

/**
 * `project-map-deltas` — one-shot: catches up on `td_berth_event` rows produced since the last
 * run and publishes their map-bound deltas to Redis. Refuses to run unless
 * `LIVE_WS_REDIS_PUBSUB_ENABLED=true`, matching every other opt-in live-data command
 * (`TD_LIVE_ENABLED`, etc.) — running it with the flag off would publish to a channel nothing
 * is configured to read from, silently wasting Redis connections for no benefit.
 */
export async function runProjectMapDeltasCommand(config: Config): Promise<void> {
  if (!config.LIVE_WS_REDIS_PUBSUB_ENABLED) {
    console.error(
      "project-map-deltas: LIVE_WS_REDIS_PUBSUB_ENABLED is not 'true' — nothing to publish to, refusing to run.",
    );
    process.exitCode = 1;
    return;
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  // A one-shot command must fail fast rather than hang: ioredis's defaults retry connecting
  // indefinitely, which would leave this command running forever if Redis is unreachable.
  const redis = new Redis(config.REDIS_URL, {
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    const summary = await runProjectMapDeltas(pool, redis);
    console.log(
      `project-map-deltas: ${summary.batches} batch(es), ${summary.processedEvents} event(s) processed, ${summary.publishedDeltas} delta(s) published`,
    );
  } finally {
    redis.disconnect();
    await pool.end();
  }
}
