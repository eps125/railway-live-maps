import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { createGarnerPool } from "../garner/garnerPool.js";
import {
  runGarnerReferenceSync,
  runGarnerScheduleSync,
  runGarnerTrustSync,
} from "../garner/bridge.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** The daemon ticks on the TRUST cadence (the most time-sensitive feed — it backs the popup's
 * "latest report"). Schedule changes are incremental and infrequent, reference data (CORPUS/
 * SMART) changes at most daily, so those run on every Nth tick. */
const TICK_INTERVAL_MS = 20 * 1000;
const SCHEDULE_EVERY_N_TICKS = 3; // ~1 min
const REFERENCE_EVERY_N_TICKS = 15; // ~5 min

/**
 * `ingest-garner` — long-running bridge that mirrors the operator's openrail-eps (`garner`)
 * MariaDB into Railway Live Maps' Postgres instead of RLM subscribing to Network Rail a second
 * time for TRUST / VSTP / SCHEDULE / CORPUS / SMART (ADR 0002). Refuses to start unless
 * `GARNER_BRIDGE_ENABLED=true` (and `loadConfig` has already checked GARNER_DB_* are set), same
 * discipline as `ingest-td`.
 *
 *  - CORPUS  -> location_reference,  SMART -> smart_berth_step   (full re-sync)
 *  - cif_schedules / cif_schedule_locations -> same-named RLM tables (watermarked mirror)
 *  - trust_* -> same-named RLM tables (watermarked mirror)
 */
export async function runIngestGarner(config: Config): Promise<void> {
  if (!config.GARNER_BRIDGE_ENABLED) {
    console.log("ingest-garner: GARNER_BRIDGE_ENABLED is not 'true', idling");
    await new Promise<never>(() => {});
    return;
  }

  const pg = createPool({ connectionString: config.DATABASE_URL });
  const garner = createGarnerPool(config);

  console.log(
    `ingest-garner: starting (garner ${config.GARNER_DB_HOST}:${config.GARNER_DB_PORT}/${config.GARNER_DB_NAME}, ` +
      `trust every ${TICK_INTERVAL_MS / 1000}s, schedule every ${
        (TICK_INTERVAL_MS * SCHEDULE_EVERY_N_TICKS) / 1000
      }s, reference every ${(TICK_INTERVAL_MS * REFERENCE_EVERY_N_TICKS) / 60000}min)`,
  );

  let tick = 0;

  await runDaemonLoop({
    label: "ingest-garner",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      tick += 1;

      const trust = await runGarnerTrustSync(garner, pg);
      const trustTotal = Object.values(trust).reduce((sum, n) => sum + n, 0);
      if (trustTotal > 0) console.log("ingest-garner: trust sync", trust);

      if (tick % SCHEDULE_EVERY_N_TICKS === 0) {
        const schedule = await runGarnerScheduleSync(garner, pg);
        if (schedule.schedulesUpserted > 0 || schedule.scheduleLocationsUpserted > 0) {
          console.log("ingest-garner: schedule sync", schedule);
        }
      }

      if (tick % REFERENCE_EVERY_N_TICKS === 0) {
        const reference = await runGarnerReferenceSync(garner, pg);
        console.log("ingest-garner: reference sync", reference);
      }
    },
    onShutdown: async () => {
      await garner.end();
      await pg.end();
    },
  });
}
