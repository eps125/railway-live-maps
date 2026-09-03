import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { CompiledMapBundle } from "@railway/map-schema";
import { liveDataStatus, tdAreasFromBundle } from "./mapVersion.js";
import { feedGapWarnings } from "./feedGaps.js";

// The berth-run resolver was removed with ADR 0002 (2026-09-01); run<->schedule correlation
// (and any `runSummary` on berth state) is deferred to a later phase that will source it from
// the garner (openrail-eps) `trust_*` mirror rather than a bespoke RLM resolver.

export interface BerthState {
  description: string | null;
  enteredAt: string | null;
}

export interface SignalState {
  state: "blank";
}

export interface QualityState {
  status: "ok" | "stale" | "unknown";
  gaps: string[];
}

export interface LiveState {
  sourceSequence: number;
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
  quality: QualityState;
}

/**
 * Computes current berth/signal/quality state for a compiled map bundle — the shared core of
 * both `GET /api/v1/maps/:slug/state` and the WebSocket `snapshot` message (docs/API_CONTRACT.md
 * §1-2), so the two never drift apart (CLAUDE.md rule 13: renderer and any other consumer share
 * the same domain model/state semantics).
 */
export async function computeLiveState(
  pool: Pool,
  bundle: CompiledMapBundle,
  now: Date,
): Promise<LiveState> {
  const berthKeys = Object.keys(bundle.berthBindingIndex);
  const tdAreas = berthKeys.map((key) => key.split("|")[0] ?? "");
  const berthCodes = berthKeys.map((key) => key.split("|")[1] ?? "");

  const currentStateResult = await pool.query<{
    td_area: string;
    berth_code: string;
    description: string | null;
    occupancy_entered_at: Date | null;
    source_ingestion_sequence: string;
  }>(
    `select bcs.td_area, bcs.berth_code, bcs.description,
            bcs.occupancy_entered_at, bcs.source_ingestion_sequence
     from berth_current_state bcs
     join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
       on wanted.td_area = bcs.td_area and wanted.berth_code = bcs.berth_code
     where bcs.projection_version = $3`,
    [tdAreas, berthCodes, TD_PROJECTION_VERSION],
  );
  const stateByKey = new Map(
    currentStateResult.rows.map((row) => [`${row.td_area}|${row.berth_code}`, row]),
  );

  let sourceSequence = 0;
  const berths: Record<string, BerthState> = {};
  for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
    const state = stateByKey.get(key);
    berths[elementId] = {
      description: state?.description ?? null,
      enteredAt: state?.occupancy_entered_at ? state.occupancy_entered_at.toISOString() : null,
    };
    if (state) {
      sourceSequence = Math.max(sourceSequence, Number(state.source_ingestion_sequence));
    }
  }

  // Lancaster (and every current-scope map) has no S-Class binding — signals are always
  // blank, never computed from movements/routes/timetables (docs/PROJECT_SPEC.md §6).
  const signals: Record<string, SignalState> = {};
  for (const element of Object.values(bundle.elementsById)) {
    if (element.type === "signal") {
      signals[element.id] = { state: "blank" };
    }
  }

  const areas = tdAreasFromBundle(bundle);
  const [status, { gaps }] = await Promise.all([
    liveDataStatus(pool, areas, now),
    feedGapWarnings(pool, areas, now),
  ]);
  const quality: QualityState = { status, gaps };

  return { sourceSequence, berths, signals, quality };
}
