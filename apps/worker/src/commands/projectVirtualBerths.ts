import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import {
  runProjectVirtualBerths,
  runVirtualBerthTdReentryHandoff,
} from "../virtualBerths/projector.js";

/** `project-virtual-berths [--rebuild]` (docs/adr/0012) — the one-shot checkpoint/rebuild
 * command for both the GPS-driven stepping pass and the TD-reentry hand-off pass, same shape as
 * `project-td [--rebuild]`. Processes whatever backlog is currently available and exits;
 * `project-virtual-berths-daemon` is the long-running equivalent. Redis publish is opt-in, same
 * gate as `project-map-deltas` — refuses to connect unless `LIVE_WS_REDIS_PUBSUB_ENABLED=true`. */
export async function runProjectVirtualBerthsCommand(
  config: Config,
  argv: string[],
): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  const redis = config.LIVE_WS_REDIS_PUBSUB_ENABLED
    ? new Redis(config.REDIS_URL, {
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
    : undefined;
  try {
    const stepSummary = await runProjectVirtualBerths(pool, { rebuild, redis });
    console.log(`project-virtual-berths complete${rebuild ? " (rebuild)" : ""}:`, stepSummary);
    const reentrySummary = await runVirtualBerthTdReentryHandoff(pool, { rebuild, redis });
    console.log(
      `project-virtual-berths (td-reentry)${rebuild ? " (rebuild)" : ""}:`,
      reentrySummary,
    );
  } finally {
    redis?.disconnect();
    await pool.end();
  }
}
