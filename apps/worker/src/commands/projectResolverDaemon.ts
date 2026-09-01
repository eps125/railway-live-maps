import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectResolver } from "../resolver/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Resolver batches touch more tables per row (candidate generation, movement correlation,
 * continuity) than project-td's, so this stays a little more conservative than
 * TICK_INTERVAL_MS in projectTdDaemon.ts — still far below the old `projector-resolver`
 * service's 1s `sleep` + node cold start. */
const TICK_INTERVAL_MS = 500;

/**
 * `project-resolver-daemon` — long-running replacement for the `projector-resolver` Portainer
 * service (2026-09 live-path hardening, docs/IMPLEMENTATION_PLAN.md). Runs the normal live loop
 * (forward scan + retry pass, both bounded by `RESOLVER_LIVE_WINDOW_HOURS`) on one warm
 * connection pool instead of a fresh `node` process every second. Only logs a line when a tick
 * actually resolved/retried something or hit lock contention — at a 500ms tick, logging every
 * empty cycle would drown anything worth reading.
 *
 * `--rebuild` and `--backfill` are not available here — run the one-shot `project-resolver
 * --rebuild` / `project-resolver --backfill --since <date>` commands from the worker console.
 * Both take their own advisory locks (self-exclusion / `:backfill`), so they're safe to run
 * alongside this daemon without stopping it.
 */
export async function runProjectResolverDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  const liveWindowMs = config.RESOLVER_LIVE_WINDOW_HOURS * 60 * 60 * 1000;

  console.log(
    `project-resolver-daemon: starting (tick ${TICK_INTERVAL_MS}ms, live window ` +
      `${config.RESOLVER_LIVE_WINDOW_HOURS}h, mapped-areas-only ${config.RESOLVER_EAGER_MAPPED_AREAS_ONLY})`,
  );

  await runDaemonLoop({
    label: "project-resolver-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      const summary = await runProjectResolver(pool, {
        liveWindowMs,
        mappedAreasOnly: config.RESOLVER_EAGER_MAPPED_AREAS_ONLY,
      });
      if (
        summary.newlyResolved > 0 ||
        summary.retried > 0 ||
        summary.skippedLockContention ||
        summary.moreBacklogRemains
      ) {
        console.log("project-resolver-daemon: tick", summary);
      }
    },
    onShutdown: async () => {
      await pool.end();
    },
  });
}
