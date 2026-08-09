import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { CompiledMapBundle } from "@railway/map-schema";
import { liveDataStatus, tdAreasFromBundle } from "./mapVersion.js";
import { extractMovementReport, runningIndicationText } from "./runSummary.js";

export interface RunSummary {
  status: "matched" | "ambiguous" | "unmatched";
  /** A short Vail-like running-indication string, only ever set when `status === "matched"` and
   * a real TRUST movement report supplies it — never fabricated (docs/PROJECT_SPEC.md §5). */
  text: string | null;
}

export interface BerthState {
  description: string | null;
  enteredAt: string | null;
  runSummary: RunSummary | null;
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
    occupancy_id: string | null;
    occupancy_entered_at: Date | null;
    source_ingestion_sequence: string;
  }>(
    `select bcs.td_area, bcs.berth_code, bcs.description, bcs.occupancy_id,
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
  const occupancyIds = currentStateResult.rows
    .map((row) => row.occupancy_id)
    .filter((id): id is string => id !== null);
  const runSummaryByOccupancyId = await computeRunSummaries(pool, occupancyIds);

  let sourceSequence = 0;
  const berths: Record<string, BerthState> = {};
  for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
    const state = stateByKey.get(key);
    berths[elementId] = {
      description: state?.description ?? null,
      enteredAt: state?.occupancy_entered_at ? state.occupancy_entered_at.toISOString() : null,
      runSummary: state?.occupancy_id
        ? (runSummaryByOccupancyId.get(state.occupancy_id) ?? null)
        : null,
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

  const quality: QualityState = {
    status: await liveDataStatus(pool, tdAreasFromBundle(bundle), now),
    gaps: [],
  };

  return { sourceSequence, berths, signals, quality };
}

/**
 * Milestone 9: `berth_run_resolution` is the resolver's stored per-occupancy outcome
 * (`apps/worker/src/resolver/projector.ts`); this only ever reads it. The short running-
 * indication `text` is looked up from the matched run's *latest* movement-type
 * `train_run_event` — `ambiguous`/`unmatched` occupancies get a status but never a fabricated
 * text (docs/PROJECT_SPEC.md §5: "TRUST is not a prediction feed").
 */
async function computeRunSummaries(
  pool: Pool,
  occupancyIds: string[],
): Promise<Map<string, RunSummary>> {
  const result = new Map<string, RunSummary>();
  if (occupancyIds.length === 0) return result;

  const resolutions = await pool.query<{
    occupancy_id: string;
    status: RunSummary["status"];
    selected_train_run_id: string | null;
  }>(
    `select occupancy_id, status, selected_train_run_id
     from berth_run_resolution where occupancy_id = any($1::bigint[])`,
    [occupancyIds],
  );

  const matchedRunIds = resolutions.rows
    .map((row) => row.selected_train_run_id)
    .filter((id): id is string => id !== null);
  const reportByRunId = new Map<string, ReturnType<typeof extractMovementReport>>();
  if (matchedRunIds.length > 0) {
    const events = await pool.query<{ train_run_id: string; raw_event_json: unknown }>(
      `select distinct on (train_run_id) train_run_id, raw_event_json
       from train_run_event
       where train_run_id = any($1::uuid[]) and trust_message_type = 'movement'
       order by train_run_id, event_at desc`,
      [matchedRunIds],
    );
    for (const row of events.rows) {
      reportByRunId.set(row.train_run_id, extractMovementReport(row.raw_event_json));
    }
  }

  for (const row of resolutions.rows) {
    const report = row.selected_train_run_id
      ? reportByRunId.get(row.selected_train_run_id)
      : undefined;
    result.set(row.occupancy_id, {
      status: row.status,
      text: report ? runningIndicationText(report) : null,
    });
  }
  return result;
}
