import type { Pool } from "pg";

/**
 * Milestone 10 — point-in-time reconstruction of a published map's berth/signal state from the
 * `berth_occupancy` history projection, shared by the API's `/state?at=` endpoint and the
 * worker's `snapshot-maps` role so a stored `map_state_snapshot` is provably the same
 * computation the live endpoint performs (CLAUDE.md rule 3: playback is a derived projection).
 *
 * `berth_occupancy` intervals are `[entered_at, left_at)` (half-open — a berth cleared at T reads
 * as clear at T), and never overlap for one berth, so "what was in berth X at T" is: the single
 * most-recent interval with `entered_at <= T`, occupied iff its `left_at` is null or `> T`.
 * Deterministic: the same inputs always yield the same output.
 *
 * Both queries are shaped to hit an existing index once per berth / area and stop
 * (`distinct on` + `order by ... entered_at desc`; a `limit 1` seek per area) — the `at` may be
 * days back over a nationwide-scale table, so a scan is not acceptable.
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
  /** `td_berth_event.ingestion_sequence` of the most recent berth event in any of the map's TD
   * areas at or before `at` (0 if none) — the deterministic "source sequence" for that instant. */
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
  const uniqueAreas = [...new Set(tdAreas)].filter((area) => area.length > 0);

  // One `(td_area, berth_code, entered_at desc)` index seek per bound berth (the `limit 1`
  // lateral), walking back from `at` to the most-recent entry. `left_at` decides occupied vs.
  // vacant in app code — putting it in `WHERE` would make a vacant berth scan its whole history
  // for a match that never comes. LATERAL (not a `join unnest`) forces the nested-loop-index
  // plan even when `at` is days back over a nationwide-scale, month-partitioned table.
  const occupancy = await pool.query<{
    td_area: string;
    berth_code: string;
    description: string;
    entered_at: Date;
    left_at: Date | null;
  }>(
    `select w.td_area, w.berth_code, bo.description, bo.entered_at, bo.left_at
       from unnest($1::text[], $2::text[]) as w(td_area, berth_code)
       cross join lateral (
         select bo.description, bo.entered_at, bo.left_at
           from berth_occupancy bo
          where bo.projection_version = $3
            and bo.td_area = w.td_area and bo.berth_code = w.berth_code
            and bo.entered_at <= $4
          order by bo.entered_at desc
          limit 1
       ) bo`,
    [tdAreas, berthCodes, options.projectionVersion, options.at],
  );
  const latestByKey = new Map(
    occupancy.rows.map((row) => [`${row.td_area}|${row.berth_code}`, row]),
  );

  const berths: Record<string, ReconstructedBerthState> = {};
  for (const [key, elementId] of Object.entries(options.berthBindingIndex)) {
    const row = latestByKey.get(key);
    const occupied = row && (row.left_at == null || row.left_at.getTime() > options.at.getTime());
    berths[elementId] = occupied
      ? { description: row.description, enteredAt: row.entered_at.toISOString() }
      : { description: null, enteredAt: null };
  }

  const signals: Record<string, { state: "blank" }> = {};
  for (const elementId of options.signalElementIds) {
    signals[elementId] = { state: "blank" };
  }

  // One `(td_area, event_at desc)` index seek per area (the correlated `limit 1`), then max —
  // never a range scan over history.
  const seq = await pool.query<{ source_sequence: string }>(
    `select coalesce(max(latest.seq), 0)::text as source_sequence
       from unnest($1::text[]) as a(area)
       cross join lateral (
         select be.ingestion_sequence as seq
           from td_berth_event be
          where be.td_area = a.area and be.event_at <= $2
          order by be.event_at desc
          limit 1
       ) latest`,
    [uniqueAreas, options.at],
  );

  return {
    sourceSequence: Number(seq.rows[0]?.source_sequence ?? "0"),
    berths,
    signals,
  };
}
