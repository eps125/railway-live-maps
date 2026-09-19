import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectVirtualBerths } from "../virtualBerths/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Background enrichment, same tick rate as `run-lineage-daemon` (docs/adr/0007) — not on the
 * hot TD live path, no reason for a tighter tick than this. */
const TICK_INTERVAL_MS = 1_000;

/**
 * `project-virtual-berths-daemon` (docs/adr/0012): steps virtual (GPS-fed) berth occupancy from
 * `trust_movement` rows sourced from GPS, for track with no TD coverage. Always safe to leave
 * running — same reasoning `run-lineage-daemon`'s own doc comment gives: no external network, no
 * Redis dependency, every write idempotent.
 */
export async function runVirtualBerthDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 15_000 });

  console.log(`project-virtual-berths-daemon: starting (tick ${TICK_INTERVAL_MS}ms)`);

  await runDaemonLoop({
    label: "project-virtual-berths-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      await runProjectVirtualBerths(pool);
    },
    onShutdown: async () => {
      await pool.end();
    },
  });
}
