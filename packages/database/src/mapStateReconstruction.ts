import type { Pool } from "pg";

/**
 * Milestone 10 — point-in-time reconstruction of a published map's berth/signal state from the
 * `berth_occupancy` history projection, shared by the API's `/state?at=` endpoint and the
 * worker's `snapshot-maps` role so a stored `map_state_snapshot` is provably the same
 * computation the live endpoint performs (CLAUDE.md rule 3: playback is a derived projection).
 *
 * `berth_occupancy` intervals are `[entered_at, left_at)` (half-open — a berth cleared at T reads
 * as clear at T), and never overlap for one berth, so "what was in berth X at T" is a single
 * interval lookup. Deterministic: the same inputs always yield the same output.
 *
 * Kept dependency-free of `@railway/domain` / `@railway/map-schema` (pass the projection version
 * and the already-compiled binding index / signal ids as plain values) so `@railway/database`
 * stays a leaf package.
 */
export interface ReconstructedBerthState {
  description: string | null;
  enteredAt: string | null;
}

export interface ReconstructedMapState {
  /** Highest `td_berth_event.ingestion_sequence` for any bound berth at or before `at` (0 if none). */
  sourceSequence: number;
  /** elementId → berth state, one entry per binding (vacant berths included as nulls). */
  berths: Record<string, ReconstructedBerthState>;
  /** elementId → always `{ state: "blank" }` in current map scope (docs/PROJECT_SPEC.md §6). */
  signals: Record<string, { state: "blank" }>;
}

export interface ReconstructMapStateOptions {
  /** `"<tdArea>|<berth>"` → elementId, i.e. a `CompiledMapBundle.berthBindingIndex`. */
  berthBindingIndex: Record<string, string>;
  /** Element ids of every `signal` element on the map. */
  signalElementIds: string[];
  /** `berth_occupancy.projection_version` to read (the TD projection version). */
  projectionVersion: number;
  at: Date;
}

export async function reconstructMapStateAt(
  pool: Pool,
  options: ReconstructMapStateOptions,
): Promise<ReconstructedMapState> {
  const keys = Object.keys(options.berthBindingIndex);
  const tdAreas = keys.map((key) => key.split("|")[0] ?? "");
  const berthCodes = keys.map((key) => key.split("|")[1] ?? "");

  const occupancy = await pool.query<{
    td_area: string;
    berth_code: string;
    description: string;
    entered_at: Date;
  }>(
    `select distinct on (bo.td_area, bo.berth_code)
            bo.td_area, bo.berth_code, bo.description, bo.entered_at
       from berth_occupancy bo
       join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
         on wanted.td_area = bo.td_area and wanted.berth_code = bo.berth_code
      where bo.projection_version = $3
        and bo.entered_at <= $4
        and (bo.left_at is null or bo.left_at > $4)
      order by bo.td_area, bo.berth_code, bo.entered_at desc`,
    [tdAreas, berthCodes, options.projectionVersion, options.at],
  );
  const occupiedByKey = new Map(
    occupancy.rows.map((row) => [`${row.td_area}|${row.berth_code}`, row]),
  );

  const berths: Record<string, ReconstructedBerthState> = {};
  for (const [key, elementId] of Object.entries(options.berthBindingIndex)) {
    const row = occupiedByKey.get(key);
    berths[elementId] = {
      description: row?.description ?? null,
      enteredAt: row ? row.entered_at.toISOString() : null,
    };
  }

  const signals: Record<string, { state: "blank" }> = {};
  for (const elementId of options.signalElementIds) {
    signals[elementId] = { state: "blank" };
  }

  const seq = await pool.query<{ source_sequence: string }>(
    `select coalesce(max(be.ingestion_sequence), 0)::text as source_sequence
       from td_berth_event be
       join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
         on wanted.td_area = be.td_area
        and (wanted.berth_code = be.from_berth or wanted.berth_code = be.to_berth)
      where be.event_at <= $3`,
    [tdAreas, berthCodes, options.at],
  );

  return {
    sourceSequence: Number(seq.rows[0]?.source_sequence ?? "0"),
    berths,
    signals,
  };
}
