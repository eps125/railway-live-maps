import type { Pool } from "pg";
import { findMapDelaysAt } from "@railway/database";
import type { BerthDelay } from "@railway/protocol";
import type { CompiledMapBundle } from "@railway/map-schema";

/**
 * Milestone 82: every delay-banded berth on a map at `at` — the WebSocket snapshot's `delays`
 * (live), and `GET /api/v1/maps/:slug/delays` (live or `?at=` for playback).
 *
 * Reads bands `ingest-garner` has already recorded when openrail-eps reported
 * (`trust_delay_band_change`); nothing here looks at TRUST movements or matches a timetable, so
 * the cost is one lookup per occupied, linked berth and nothing at all per berth step. See
 * `findMapDelaysAt` for exactly which berths qualify.
 */
export async function computeDelayBands(
  pool: Pool,
  bundle: CompiledMapBundle,
  at: Date,
): Promise<BerthDelay[]> {
  const berths = Object.keys(bundle.berthBindingIndex).map((key) => {
    const [tdArea, berth] = key.split("|");
    return { tdArea: tdArea ?? "", berth: berth ?? "" };
  });
  const rows = await findMapDelaysAt(pool, berths, at);

  const delays: BerthDelay[] = [];
  for (const row of rows) {
    if (row.band === "none") continue;
    const elementId = bundle.berthBindingIndex[`${row.tdArea}|${row.berth}`];
    if (!elementId) continue;
    delays.push({
      runKey: row.runKey,
      elementId,
      description: row.description,
      band: row.band,
      matchConfidence: row.matchConfidence,
    });
  }
  return delays;
}
