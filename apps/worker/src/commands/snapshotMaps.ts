import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runSnapshotMaps } from "../mapProjector/snapshotMaps.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/**
 * `snapshot-maps` (one-shot) / `snapshot-maps-daemon` (role) — Milestone 10. Writes one
 * `map_state_snapshot` row per currently-effective published map version, "as of now", using the
 * same `reconstructMapStateAt` the API's `/state?at=` calls. Idempotent on
 * `(map_version_id, projection_version, snapshot_time)`, so a re-run at the same instant is a
 * no-op. Pruning old snapshots is a Milestone 13 retention concern.
 */
export async function runSnapshotMapsCommand(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runSnapshotMaps(pool);
    console.log(
      `snapshot-maps: wrote ${summary.mapVersionsSnapshotted} snapshot(s), ` +
        `${summary.skippedExisting} already existed`,
    );
  } finally {
    await pool.end();
  }
}

export async function runSnapshotMapsDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 30_000 });

  console.log(`snapshot-maps-daemon: starting (every ${config.SNAPSHOT_INTERVAL_MS}ms)`);

  await runDaemonLoop({
    label: "snapshot-maps-daemon",
    intervalMs: config.SNAPSHOT_INTERVAL_MS,
    tick: async () => {
      const summary = await runSnapshotMaps(pool);
      if (summary.mapVersionsSnapshotted > 0) {
        console.log(`snapshot-maps-daemon: wrote ${summary.mapVersionsSnapshotted} snapshot(s)`);
      }
    },
    onShutdown: async () => {
      await pool.end();
    },
  });
}
