import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { reconstructMapStateAt } from "@railway/database";
import type { CompiledMapBundle } from "@railway/map-schema";
import type { LiveState } from "./liveState.js";
import { tdAreasFromBundle } from "./mapVersion.js";
import { feedGapWarnings } from "./feedGaps.js";

/**
 * Milestone 10 — point-in-time reconstruction of a compiled map's state at a past time `at`.
 * Thin wrapper over `@railway/database`'s `reconstructMapStateAt` (the shared, deterministic
 * `berth_occupancy` reconstruction that the `snapshot-maps` worker role also uses) that adds the
 * `quality` block (`feed_gap` warnings — recorder outages must stay visible, docs/PROJECT_SPEC.md
 * §11.8). Returns the same `LiveState` shape as `computeLiveState`, so `/state`, the WS snapshot
 * and playback all speak one state model (CLAUDE.md rule 13).
 */
export async function reconstructStateAt(
  pool: Pool,
  bundle: CompiledMapBundle,
  at: Date,
): Promise<LiveState> {
  const signalElementIds = Object.values(bundle.elementsById)
    .filter((element) => element.type === "signal")
    .map((element) => element.id);

  const [{ sourceSequence, berths, signals }, { gaps, coversAt }] = await Promise.all([
    reconstructMapStateAt(pool, {
      berthBindingIndex: bundle.berthBindingIndex,
      signalElementIds,
      projectionVersion: TD_PROJECTION_VERSION,
      at,
    }),
    feedGapWarnings(pool, tdAreasFromBundle(bundle), at),
  ]);

  return {
    sourceSequence,
    berths,
    signals,
    quality: { status: coversAt ? "stale" : "ok", gaps },
  };
}
