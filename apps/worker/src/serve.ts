import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckConnectivity } from "./commands/checkConnectivity.js";
import type { Config } from "./config.js";

export const HEARTBEAT_FILE = join(tmpdir(), "railway-worker-heartbeat");
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Milestone 1 has no ingestion roles yet, so the default worker process is an idle
 * daemon: it proves container liveness (heartbeat file, read by healthcheck.ts) and
 * periodically logs Postgres/Redis/archive reachability. Real roles (ingest-td, etc.)
 * replace/extend this in later milestones.
 */
export async function runServe(config: Config): Promise<never> {
  console.log("worker idle — no ingestion roles configured yet (Milestone 1)");

  const tick = async (): Promise<void> => {
    await writeFile(HEARTBEAT_FILE, new Date().toISOString());
    try {
      await runCheckConnectivity(config);
    } catch (error) {
      console.error("connectivity check failed", error);
    }
  };

  await tick();
  setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);

  return new Promise<never>(() => {
    // Runs until the container receives SIGTERM/SIGINT.
  });
}
