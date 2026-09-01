import { createPool } from "@railway/database";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { createGarnerPool } from "../garner/garnerPool.js";
import {
  runGarnerReferenceSync,
  runGarnerScheduleSync,
  runGarnerTrustSync,
} from "../garner/bridge.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

const TICK_INTERVAL_MS = 20 * 1000;
const SCHEDULE_EVERY_N_TICKS = 1; // small batches (bridge.SCHEDULE_BATCH), so run every tick
const REFERENCE_EVERY_N_TICKS = 15; // ~5 min

/** If `projector-td` (the live berth path) is more than this far behind, `ingest-garner` skips
 * its heavier schedule/reference work for that tick — the map always wins. The tiny incremental
 * trust tail still runs so the popup stays fresh. */
const PROJECTOR_LAG_PAUSE_MS = 8_000;

async function projectorTdLagMs(pg: Pool): Promise<number> {
  try {
    const result = await pg.query<{ ms: string | null }>(
      `select extract(epoch from (now() - last_completed_at)) * 1000 as ms
       from projection_checkpoint pc
       join projection_definition pd on pd.id = pc.projection_definition_id
       where pd.name = 'td-berth-and-s-class'`,
    );
    const ms = result.rows[0]?.ms;
    return ms == null ? 0 : Number(ms);
  } catch {
    // If we can't even read the checkpoint, assume the DB is under stress and hold back.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * `ingest-garner` — long-running bridge that mirrors the operator's openrail-eps (`garner`)
 * MariaDB into Railway Live Maps' Postgres instead of RLM subscribing to Network Rail a second
 * time for TRUST / VSTP / SCHEDULE / CORPUS / SMART (ADR 0002). Refuses to start unless
 * `GARNER_BRIDGE_ENABLED=true` (and `loadConfig` has already checked GARNER_DB_* are set), same
 * discipline as `ingest-td`.
 *
 * Self-throttling (2026-09-01, after the initial backfill starved the live projector):
 *  - small per-batch row caps (`bridge.SCHEDULE_BATCH` / `TRUST_BATCH`),
 *  - `synchronous_commit = off` on this pool — every write here is rebuildable mirror data, so
 *    trading crash-durability for far less WAL fsync pressure is free,
 *  - skips the schedule + reference sync on any tick where `projector-td` is lagging.
 */
export async function runIngestGarner(config: Config): Promise<void> {
  if (!config.GARNER_BRIDGE_ENABLED) {
    console.log("ingest-garner: GARNER_BRIDGE_ENABLED is not 'true', idling");
    await new Promise<never>(() => {});
    return;
  }

  const pg = createPool({
    connectionString: config.DATABASE_URL,
    max: 4,
    onConnectSql: "set synchronous_commit = off",
  });
  const garner = createGarnerPool(config);

  console.log(
    `ingest-garner: starting (garner ${config.GARNER_DB_HOST}:${config.GARNER_DB_PORT}/${config.GARNER_DB_NAME}, ` +
      `tick ${TICK_INTERVAL_MS / 1000}s, pauses schedule/reference sync while projector-td lag > ${
        PROJECTOR_LAG_PAUSE_MS / 1000
      }s)`,
  );

  let tick = 0;

  await runDaemonLoop({
    label: "ingest-garner",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      tick += 1;

      // Trust tail is tiny per batch — always run it.
      const trust = await runGarnerTrustSync(garner, pg, config.GARNER_BRIDGE_BACKFILL_DAYS);
      const trustTotal = Object.values(trust).reduce((sum, n) => sum + n, 0);
      if (trustTotal > 0) console.log("ingest-garner: trust sync", trust);

      const lagMs = await projectorTdLagMs(pg);
      if (lagMs > PROJECTOR_LAG_PAUSE_MS) {
        // Log at ~REFERENCE cadence, not every tick, so a sustained lag doesn't flood the log.
        if (tick % REFERENCE_EVERY_N_TICKS === 0) {
          console.log(
            `ingest-garner: projector-td lag ${Math.round(lagMs)}ms > ${PROJECTOR_LAG_PAUSE_MS}ms — ` +
              "pausing schedule/reference sync until the live path catches up",
          );
        }
        return;
      }

      if (tick % SCHEDULE_EVERY_N_TICKS === 0) {
        const schedule = await runGarnerScheduleSync(
          garner,
          pg,
          config.GARNER_BRIDGE_BACKFILL_DAYS,
        );
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
