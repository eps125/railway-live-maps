import type { Pool } from "pg";
import {
  TD_PROJECTION_VERSION,
  barrierBindingsFromIndex,
  barrierStateFromSignalState,
  computeSignalStates,
  inferredCrossingStates,
  inferredInputBindings,
  joinCombinedBerthState,
  routeBindingsFromIndex,
  routeStateFromSignalState,
  signalBindingsFromIndex,
  type BarrierDisplayState,
  type RouteDisplayState,
  type SignalDisplayState,
} from "@railway/domain";
import { createSignalFactsPort } from "@railway/database";
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
  state: SignalDisplayState;
}

export interface QualityState {
  status: "ok" | "stale" | "unknown";
  gaps: string[];
}

export interface LiveState {
  sourceSequence: number;
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
  /** Milestone 55 / ADR 0014: each level crossing's barrier position. Empty when the map has no
   * crossings; a crossing with no binding is present and `blank`, exactly like an unbound
   * signal. */
  crossings: Record<string, { state: BarrierDisplayState }>;
  /** Milestone 64 / ADR 0016: each route's state, from its bound route bit only. An unbound
   * route is present and `blank`; the public map draws a route only when it is `set`. */
  routes: Record<string, { state: RouteDisplayState }>;
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

  // Grouped by elementId (not assigned 1:1 from berthBindingIndex) because a combined berth
  // (docs/MAP_EDITOR_SPEC.md's berth section) has more than one `tdArea|berth` key mapping to the
  // same elementId — assigning `berths[elementId]` per key here previously let the last key
  // processed silently clobber every earlier member's state for that element.
  let sourceSequence = 0;
  const membersByElement = new Map<
    string,
    Array<{
      tdArea: string;
      berth: string;
      order: number;
      description: string | null;
      enteredAt: string | null;
    }>
  >();
  for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
    const state = stateByKey.get(key);
    const [tdArea, berth] = key.split("|");
    const list = membersByElement.get(elementId) ?? [];
    list.push({
      tdArea: tdArea ?? "",
      berth: berth ?? "",
      order: bundle.berthBindingOrder?.[key] ?? 1,
      description: state?.description ?? null,
      enteredAt: state?.occupancy_entered_at ? state.occupancy_entered_at.toISOString() : null,
    });
    membersByElement.set(elementId, list);
    if (state) {
      sourceSequence = Math.max(sourceSequence, Number(state.source_ingestion_sequence));
    }
  }
  const berths: Record<string, BerthState> = {};
  for (const [elementId, members] of membersByElement) {
    berths[elementId] = joinCombinedBerthState(members);
  }

  const { signals, crossings, routes } = await sClassStatesForBundle(pool, bundle, now, true);

  const areas = tdAreasFromBundle(bundle);
  const [status, { gaps }] = await Promise.all([
    liveDataStatus(pool, areas, now),
    feedGapWarnings(pool, areas, now),
  ]);
  const quality: QualityState = { status, gaps };

  return { sourceSequence, berths, signals, crossings, routes, quality };
}

/**
 * Every signal element's and level crossing's state for a compiled bundle at `at` (Milestone 36b;
 * crossings added by Milestone 55 / ADR 0014). Only an explicit binding ever gives either a
 * non-blank state — never train movements, routes or timetables (CLAUDE.md rules 9/10). Shared by
 * live state (`live = true`: brings the stored facts up to "now") and `/state?at=`
 * (`reconstructState.ts`).
 *
 * Signals and barriers resolve in **one** call, not two: they are the same "one bound bit, two
 * states or blank" problem over the same byte facts, so combining them keeps it to a single set
 * of database round-trips and makes it impossible for the two to be resolved against different
 * facts or a different `at`. Only the vocabulary differs, and `@railway/domain` converts it at
 * the edges.
 */
export async function sClassStatesForBundle(
  pool: Pool,
  bundle: CompiledMapBundle,
  at: Date,
  live: boolean,
): Promise<{
  signals: Record<string, SignalState>;
  crossings: Record<string, { state: BarrierDisplayState }>;
  routes: Record<string, { state: RouteDisplayState }>;
}> {
  const elements = Object.values(bundle.elementsById);
  const signalElementIds = elements
    .filter((element) => element.type === "signal")
    .map((element) => element.id);
  const crossingElementIds = elements
    .filter((element) => element.type === "levelCrossing")
    .map((element) => element.id);
  // Milestone 64 / ADR 0016: routes resolve in the same call, against the same facts and `at`.
  const routeElementIds = elements
    .filter((element) => element.type === "route")
    .map((element) => element.id);

  const inputElementIds = inferredInputBindings(bundle.inferredBarrierBindings).map(
    (binding) => binding.elementId,
  );
  const resolved = await computeSignalStates(createSignalFactsPort(pool), {
    signalElementIds: [
      ...signalElementIds,
      ...crossingElementIds,
      ...routeElementIds,
      ...inputElementIds,
    ],
    bindings: [
      ...signalBindingsFromIndex(bundle.sBitBindingIndex ?? {}, bundle.sBitBindingActiveMeans),
      ...barrierBindingsFromIndex(bundle.barrierBindingIndex, bundle.barrierBindingActiveMeans),
      ...routeBindingsFromIndex(bundle.routeBindingIndex, bundle.routeBindingActiveMeans),
      // Milestone 59 / ADR 0015: each inferred crossing's input signals, resolved under synthetic
      // element ids by the very same machinery (trust, lookback, live overlay) as a real signal.
      ...inferredInputBindings(bundle.inferredBarrierBindings),
    ],
    at,
    live,
  });
  const inferred = inferredCrossingStates(bundle.inferredBarrierBindings, resolved);

  const signals: Record<string, SignalState> = {};
  for (const id of signalElementIds) signals[id] = resolved[id] ?? { state: "blank" };
  const crossings: Record<string, { state: BarrierDisplayState }> = {};
  for (const id of crossingElementIds) {
    crossings[id] = {
      state: inferred[id] ?? barrierStateFromSignalState(resolved[id]?.state ?? "blank"),
    };
  }
  const routes: Record<string, { state: RouteDisplayState }> = {};
  for (const id of routeElementIds) {
    routes[id] = { state: routeStateFromSignalState(resolved[id]?.state ?? "blank") };
  }
  return { signals, crossings, routes };
}
