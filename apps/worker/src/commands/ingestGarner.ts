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
const REFERENCE_EVERY_N_TICKS = 15; // ~5 min

/** `ingest-garner` skips a whole tick if EITHER holds:
 *  - `projector-td` hasn't completed a batch in this long (it is stalled), or
 *  - `projector-td` is more than this many TD events behind the newest ingested one (it is
 *    running but underwater — the case a "time since last batch" check misses: during the
 *    post-incident catch-up its `last_completed_at` was only ~3s old while it was ~95k events
 *    / 18 min behind). */
const PROJECTOR_STALL_MS = 8_000;
const PROJECTOR_BACKLOG_EVENTS = 5_000;

interface ProjectorHealth {
  stalledMs: number;
  backlogEvents: number;
}

async function projectorHealth(pg: Pool): Promise<ProjectorHealth> {
  try {
    const result = await pg.query<{ stalled_ms: string | null; backlog: string | null }>(
      `select extract(epoch from (now() - pc.last_completed_at)) * 1000 as stalled_ms,
              (select max(ingestion_sequence) from raw_feed_event where feed_name = 'TD')
                - pc.last_ingestion_sequence::bigint as backlog
       from projection_checkpoint pc
       join projection_definition pd on pd.id = pc.projection_definition_id
       where pd.name = 'td-berth-and-s-class'`,
    );
    const row = result.rows[0];
    return {
      stalledMs: row?.stalled_ms == null ? 0 : Number(row.stalled_ms),
      backlogEvents: row?.backlog == null ? 0 : Number(row.backlog),
    };
  } catch {
    // If we can't even read the checkpoint, assume the DB is under stress and hold back.
    return { stalledMs: Number.POSITIVE_INFINITY, backlogEvents: Number.POSITIVE_INFINITY };
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
 *  - skips the whole tick (trust included) whenever `projector-td` is stalled OR more than
 *    `PROJECTOR_BACKLOG_EVENTS` behind the newest ingested TD event (see `projectorHealth`).
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
      `tick ${TICK_INTERVAL_MS / 1000}s, pauses schedule/reference sync while projector-td is ` +
      `stalled >${PROJECTOR_STALL_MS / 1000}s or >${PROJECTOR_BACKLOG_EVENTS} events behind)`,
  );

  let tick = 0;

  await runDaemonLoop({
    label: "ingest-garner",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      tick += 1;

      // The live berth path always wins: if `projector-td` is stalled or underwater, skip this
      // whole tick — trust included. A few tens of seconds of stale "latest movement" on the
      // popup is a fine price for not competing with the map projector's catch-up.
      const health = await projectorHealth(pg);
      if (
        health.stalledMs > PROJECTOR_STALL_MS ||
        health.backlogEvents > PROJECTOR_BACKLOG_EVENTS
      ) {
        if (tick % REFERENCE_EVERY_N_TICKS === 0) {
          console.log(
            `ingest-garner: projector-td ${Math.round(health.stalledMs)}ms since last batch, ` +
              `${health.backlogEvents} events behind — pausing all garner sync this tick`,
          );
        }
        return;
      }

      const trust = await runGarnerTrustSync(garner, pg, config.GARNER_BRIDGE_BACKFILL_DAYS);
      const trustTotal = Object.values(trust).reduce((sum, n) => sum + n, 0);
      if (trustTotal > 0) console.log("ingest-garner: trust sync", trust);

      const schedule = await runGarnerScheduleSync(garner, pg, config.GARNER_BRIDGE_BACKFILL_DAYS);
      if (schedule.schedulesUpserted > 0 || schedule.scheduleLocationsUpserted > 0) {
        console.log("ingest-garner: schedule sync", schedule);
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
