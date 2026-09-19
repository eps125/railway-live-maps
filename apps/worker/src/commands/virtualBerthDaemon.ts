import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import {
  runProjectVirtualBerths,
  runVirtualBerthTdReentryHandoff,
} from "../virtualBerths/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Background enrichment, same tick rate as `run-lineage-daemon` (docs/adr/0007) — not on the
 * hot TD live path, no reason for a tighter tick than this. */
const TICK_INTERVAL_MS = 1_000;

/**
 * `project-virtual-berths-daemon` (docs/adr/0012, gap-closure follow-up 2026-09-19): steps
 * virtual (GPS-fed) berth occupancy from `trust_movement` rows sourced from GPS, for track with
 * no TD coverage, and closes a virtual occupancy on a corroborated TD-coverage re-entry
 * (`runVirtualBerthTdReentryHandoff`). Always safe to leave running — no external network, every
 * write idempotent.
 *
 * Optional Redis publish (`LIVE_WS_REDIS_PUBSUB_ENABLED=true`): both passes publish to the same
 * `railway:live:{slug}` channels `apps/worker/src/mapProjector/projector.ts` (TD) does, drawing
 * `sequence` from the shared `live_delta_sequence` Postgres sequence so an interleaved TD/virtual
 * delta never looks like a regression to a connected client. **Known limitation, not fixed here**:
 * the *hot* TD live path (`apps/worker/src/td/liveProjector.ts`, `ingest-td`'s inline publish +
 * `project-td-live-daemon`) still embeds raw `td_berth_event.ingestion_sequence` as its own
 * client-facing `sequence`, not `live_delta_sequence` — decoupling that from the Redis-side
 * per-berth dedup watermark it also drives needs its own careful pass (a DB round-trip inline
 * there is a real latency risk on the path ADR 0003 built specifically to keep fast), not one
 * bundled into this fix. Until that lands, a map with both TD-bound and virtual-bound berths on
 * a Redis-backed live connection can see an occasional spurious reconnect when the two interleave
 * — self-healing (a fresh snapshot follows immediately), never a correctness/data-loss issue, and
 * the default polling path (what's actually deployed — `LIVE_WS_REDIS_PUBSUB_ENABLED` defaults
 * `false`) is unaffected either way.
 */
export async function runVirtualBerthDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 15_000 });
  const redis: Redis | null = config.LIVE_WS_REDIS_PUBSUB_ENABLED
    ? new Redis(config.REDIS_URL)
    : null;

  console.log(
    `project-virtual-berths-daemon: starting (tick ${TICK_INTERVAL_MS}ms, redis publish ${
      redis ? "enabled" : "disabled"
    })`,
  );

  await runDaemonLoop({
    label: "project-virtual-berths-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      await runProjectVirtualBerths(pool, { redis: redis ?? undefined });
      await runVirtualBerthTdReentryHandoff(pool, { redis: redis ?? undefined });
    },
    onShutdown: async () => {
      if (redis) redis.disconnect();
      await pool.end();
    },
  });
}
