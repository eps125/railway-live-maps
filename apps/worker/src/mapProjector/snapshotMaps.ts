import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { reconstructMapStateAt, type ReconstructedMapState } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { CompiledMapBundle } from "@railway/map-schema";

/**
 * Milestone 10 — write one `map_state_snapshot` row per currently-effective published map
 * version, capturing its reconstructed berth/signal state "as of now". Uses the exact same
 * `reconstructMapStateAt` the API's `/state?at=` calls, so a snapshot is a cached copy of that
 * computation — never an independent source of truth (CLAUDE.md rule 3). The snapshots exist so
 * map state stays reconstructable/auditable if `berth_occupancy`/`td_berth_event` are ever
 * pruned under a retention policy (docs/PROJECT_SPEC.md §9).
 *
 * `on conflict do nothing` on `(map_version_id, projection_version, snapshot_time)` makes a
 * re-run at the same wall-clock instant idempotent.
 */
export interface SnapshotMapsSummary {
  mapVersionsSnapshotted: number;
  skippedExisting: number;
}

interface MapVersionRow {
  id: string;
  slug: string;
  version_number: number;
  compiled_runtime_bundle: CompiledMapBundle;
}

/** Deterministic JSON for the checksum: object keys sorted recursively. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function checksumOf(state: Pick<ReconstructedMapState, "berths" | "signals">): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

export async function runSnapshotMaps(
  pool: Pool,
  now: Date = new Date(),
): Promise<SnapshotMapsSummary> {
  const versions = await pool.query<MapVersionRow>(
    `select mv.id, m.slug, mv.version_number, mv.compiled_runtime_bundle
       from map_version mv
       join map m on m.id = mv.map_id
      where mv.effective_from <= $1 and (mv.effective_to is null or mv.effective_to > $1)
      order by m.slug`,
    [now],
  );

  let mapVersionsSnapshotted = 0;
  let skippedExisting = 0;

  for (const version of versions.rows) {
    const bundle = version.compiled_runtime_bundle;
    const signalElementIds = Object.values(bundle.elementsById ?? {})
      .filter((element) => element.type === "signal")
      .map((element) => element.id);

    const { sourceSequence, berths, signals } = await reconstructMapStateAt(pool, {
      berthBindingIndex: bundle.berthBindingIndex ?? {},
      signalElementIds,
      projectionVersion: TD_PROJECTION_VERSION,
      at: now,
    });
    const state = { berths, signals };

    const inserted = await pool.query(
      `insert into map_state_snapshot
         (map_version_id, projection_version, snapshot_time, last_event_sequence, state, checksum)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (map_version_id, projection_version, snapshot_time) do nothing`,
      [
        version.id,
        TD_PROJECTION_VERSION,
        now,
        sourceSequence,
        JSON.stringify(state),
        checksumOf(state),
      ],
    );
    if ((inserted.rowCount ?? 0) > 0) mapVersionsSnapshotted += 1;
    else skippedExisting += 1;
  }

  return { mapVersionsSnapshotted, skippedExisting };
}

export { checksumOf as snapshotChecksumOf, stableStringify as stableStringifyForSnapshot };
