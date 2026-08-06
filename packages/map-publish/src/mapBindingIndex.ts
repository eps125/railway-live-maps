import type { CompiledMapBundle } from "@railway/map-schema";

/** Structural subset of `pg`'s `PoolClient`/`Pool` — just enough to run typed queries within
 * whatever transaction the caller already has open (matches the `Queryable` pattern
 * `@railway/database`'s checkpoint helpers use). */
export interface Queryable {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Milestone 6: populates `map_binding_index` from a compiled map bundle's
 * `berthBindingIndex`/`sBitBindingIndex` (`packages/map-schema/src/compiler.ts`). Shared by
 * every publish path (`publish-map` CLI, the editor's publish API route) and the
 * `backfill-map-bindings` command (versions published before this table existed) so there is
 * exactly one place that knows how to turn the compiled index into rows.
 *
 * Idempotent: safe to call twice for the same `mapVersionId` (`on conflict do nothing` against
 * the partial unique indexes from migration 0010) — but map versions are immutable, so in
 * practice this only ever runs once per version.
 */
export async function insertMapBindingIndexRows(
  client: Queryable,
  mapVersionId: string,
  bundle: CompiledMapBundle,
): Promise<void> {
  // Defensive: every real compiled bundle (compileMapDocument's output) always has both index
  // fields, but a malformed/placeholder bundle should insert zero rows rather than throw and
  // abort whatever loop (e.g. backfill-map-bindings) is iterating over many map_versions.
  for (const [key, elementId] of Object.entries(bundle.berthBindingIndex ?? {})) {
    const [tdArea, berth] = key.split("|");
    await client.query(
      `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
       values ($1, $2, 'td_berth', $3, $4)
       on conflict do nothing`,
      [mapVersionId, elementId, tdArea, berth],
    );
  }

  for (const [key, elementId] of Object.entries(bundle.sBitBindingIndex ?? {})) {
    const [tdArea, address, bit] = key.split("|");
    await client.query(
      `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit)
       values ($1, $2, 'td_s_bit', $3, $4, $5)
       on conflict do nothing`,
      [mapVersionId, elementId, tdArea, address, bit],
    );
  }
}
