import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { createGarnerPool } from "../garner/garnerPool.js";
import { runGarnerScheduleFullReconcile } from "../garner/bridge.js";

/**
 * `reconcile-garner-schedules` — one-shot console command (run from the `worker` container like
 * `migrate`). Diffs every garner `cif_schedules` id against RLM's mirror and repairs every
 * missing or changed schedule header and every mismatched calling-point set. The historical
 * backfill for the 2026-09-21 incident (34,179 schedules and 2,797 location sets never mirrored,
 * see `diffScheduleWindow`); `ingest-garner` runs the same reconcile continuously on a rolling
 * window, so this is only needed to close a known gap immediately. Idempotent and safe to run
 * alongside `ingest-garner`: every write is an upsert or a transactional location replace.
 * Never deletes an RLM schedule garner no longer has.
 */
export async function runReconcileGarnerSchedules(config: Config): Promise<void> {
  if (!config.GARNER_DB_HOST || !config.GARNER_DB_USER) {
    throw new Error("reconcile-garner-schedules requires GARNER_DB_HOST and GARNER_DB_USER");
  }
  const pg = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 120_000 });
  const garner = createGarnerPool(config);
  try {
    const totals = await runGarnerScheduleFullReconcile(garner, pg, (window) => {
      if (window.schedulesRepaired > 0 || window.locationSetsRepaired > 0) {
        console.log("reconcile-garner-schedules: window repaired", window);
      }
    });
    console.log("reconcile-garner-schedules: done", totals);
  } finally {
    await garner.end();
    await pg.end();
  }
}
