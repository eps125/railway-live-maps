import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import {
  runProjectRunLineage,
  seedRunLineageCheckpointIfFresh,
  sweepFreshResolution,
  createFreshResolutionCooldown,
  createBoundaryCooldown,
  type RunLineageSummary,
} from "../runLineage/projector.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/** Background enrichment, not latency-sensitive (docs/adr/0007) — a 1s tick is plenty. */
const TICK_INTERVAL_MS = 1_000;

/**
 * `run-lineage-daemon` (Milestone 39, docs/adr/0007): threads an already-`resolved` run identity
 * forward along `td_berth_event` `CA` step chains and owner-curated `td_area_boundary` crossings.
 *
 * docs/adr/0007 addendum (2026-09-14, `RUN_LINEAGE_FRESH_RESOLUTION_ENABLED`): also proactively
 * *establishes* a run for any open, unlinked occupancy in an eligible TD area
 * (`RUN_LINEAGE_FRESH_RESOLUTION_SCOPE` — "mapped", the default, or "nationwide") — before this,
 * a run was only ever established reactively, on a popup click (`currentRun.ts`), so a train never
 * clicked at a well-covered berth could go completely unidentified for its whole journey. Off by
 * default, same discipline as every other live-path flag. The cooldown map is created once here
 * (not inside the sweep) so it actually persists across ticks — see `sweepFreshResolution`'s own
 * doc comment.
 *
 * Second addendum (2026-09-15): the same flag/scope also gates step-chain *upgrades* — a weak
 * (`headcode_only`) identity established at a berth with no SMART coverage, then inherited
 * unchanged via step-chain into a well-covered berth further down the route, now gets a fresh,
 * position-scoped second look there instead of staying permanently capped at the weak tier (found
 * against a real report: a train correctly identified by headcode alone at an uncovered origin
 * berth, then stepping through Preston/Lancaster/Carnforth — all well-covered — without the match
 * ever strengthening). See `processStepChainBatch`'s own doc comment.
 */
export async function runRunLineageDaemon(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 15_000 });

  console.log(
    `run-lineage-daemon: starting (tick ${TICK_INTERVAL_MS}ms, fresh resolution ${
      config.RUN_LINEAGE_FRESH_RESOLUTION_ENABLED
        ? `enabled, scope=${config.RUN_LINEAGE_FRESH_RESOLUTION_SCOPE}`
        : "disabled"
    })`,
  );
  // Skip the historical backlog on a genuinely fresh checkpoint — see the function's own doc
  // comment (production incident, 2026-09-14) for why replaying nationwide history here is both
  // pointless (sticky matching only helps live, ongoing movements) and was actively harmful (cold
  // partition reads blew the statement timeout on the very first batch).
  await seedRunLineageCheckpointIfFresh(pool);

  const freshResolutionCooldown = createFreshResolutionCooldown();
  const boundaryCooldown = createBoundaryCooldown();

  await runDaemonLoop({
    label: "run-lineage-daemon",
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      const summary: RunLineageSummary = await runProjectRunLineage(pool, {
        freshResolutionScope: config.RUN_LINEAGE_FRESH_RESOLUTION_ENABLED
          ? config.RUN_LINEAGE_FRESH_RESOLUTION_SCOPE
          : null,
        boundaryCooldown,
      });
      if (config.RUN_LINEAGE_FRESH_RESOLUTION_ENABLED) {
        await sweepFreshResolution(
          pool,
          config.RUN_LINEAGE_FRESH_RESOLUTION_SCOPE,
          freshResolutionCooldown,
          summary,
        );
      }
    },
    onShutdown: async () => {
      await pool.end();
    },
  });
}
