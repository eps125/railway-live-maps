import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { createGarnerPool } from "../garner/garnerPool.js";
import { runGarnerReferenceSync } from "../garner/bridge.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Reference data (CORPUS/SMART) changes at most daily — a full re-sync every few minutes is
 * plenty and cheap (~40-60k small rows). */
const REFERENCE_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `ingest-garner` — long-running bridge that mirrors the operator's openrail-eps (`garner`)
 * MariaDB into Railway Live Maps' Postgres instead of RLM subscribing to Network Rail a second
 * time (ADR 0002 / docs/IMPLEMENTATION_PLAN.md Milestone 15 step "2 new"). Refuses to start
 * unless `GARNER_BRIDGE_ENABLED=true` (and `loadConfig` has already checked GARNER_DB_* are set),
 * same discipline as `ingest-td`.
 *
 * Implemented: CORPUS → `location_reference`, SMART → `smart_berth_step` (full re-sync, `source =
 * 'GARNER'`). **Not yet wired** (own follow-up — needs migration widening `schedule.source`'s
 * CHECK to include 'GARNER', plus an STP-indicator mapping and the reducer glue): cif_schedules /
 * cif_schedule_locations → schedule / schedule_location, and trust_movement / trust_activation_extra
 * / trust_* → train_run / train_run_event via `packages/domain/src/trust/runReducer.ts`. Until
 * those land, keep `ingest-trust` / `ingest-vstp` / the `download-*` schedule commands running as
 * the source for TRUST and CIF-schedule data.
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
      `reference sync every ${REFERENCE_SYNC_INTERVAL_MS / 60_000}min)`,
  );

  await runDaemonLoop({
    label: "ingest-garner",
    intervalMs: REFERENCE_SYNC_INTERVAL_MS,
    tick: async () => {
      const summary = await runGarnerReferenceSync(garner, pg);
      console.log("ingest-garner: reference sync", summary);
    },
    onShutdown: async () => {
      await garner.end();
      await pg.end();
    },
  });
}
