import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "@railway/database";
import { runCheckConnectivity } from "./commands/checkConnectivity.js";
import type { Config } from "./config.js";
import { runMaintenanceJobLoop } from "./maintenance/runner.js";

export const HEARTBEAT_FILE = join(tmpdir(), "railway-worker-heartbeat");
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The default worker process: it proves container liveness (heartbeat file, read by
 * healthcheck.ts) and periodically logs Postgres/Redis/archive reachability. Milestone 97a
 * (docs/adr/0021): it also runs the admin-queued area maintenance jobs (`maintenance_job`), one
 * at a time.
 */
export async function runServe(config: Config): Promise<void> {
  console.log("worker serving — heartbeat, connectivity checks and maintenance jobs");

  const tick = async (): Promise<void> => {
    await writeFile(HEARTBEAT_FILE, new Date().toISOString());
    try {
      await runCheckConnectivity(config);
    } catch (error) {
      console.error("connectivity check failed", error);
    }
  };

  await tick();
  const heartbeat = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);

  // Same per-statement bound as `repair-run-links`, whose work the link backfill job runs.
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 120_000 });
  try {
    // Resolves on SIGTERM/SIGINT, which it handles itself — so this function must return then,
    // or the process would never exit (the 2026-09-11 ingest-td lesson).
    await runMaintenanceJobLoop(pool);
  } finally {
    clearInterval(heartbeat);
    await pool.end();
  }
}
