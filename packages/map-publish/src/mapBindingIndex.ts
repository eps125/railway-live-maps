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
    const combinedOrder = bundle.berthBindingOrder?.[key] ?? null;
    await client.query(
      `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth, combined_order)
       values ($1, $2, 'td_berth', $3, $4, $5)
       on conflict do nothing`,
      [mapVersionId, elementId, tdArea, berth, combinedOrder],
    );
  }

  for (const [key, elementId] of Object.entries(bundle.sBitBindingIndex ?? {})) {
    const [tdArea, address, bit] = key.split("|");
    // Milestone 36b: the live publishers need `activeMeans` to turn a bit into on/off. Null for a
    // bundle compiled before it was recorded — those signals stay blank rather than guessed.
    const activeMeans = bundle.sBitBindingActiveMeans?.[key] ?? null;
    await client.query(
      `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit, active_means)
       values ($1, $2, 'td_s_bit', $3, $4, $5, $6)
       on conflict do nothing`,
      [mapVersionId, elementId, tdArea, address, bit, activeMeans],
    );
  }

  // Milestone 55 / ADR 0014: a level crossing's barrier bit. Same shape as a signal binding, but
  // its own binding_type and its own up/down `active_means` vocabulary (enforced by the check
  // constraint in migration 0039), so a barrier bit can never be read as a signal bit.
  for (const [key, elementId] of Object.entries(bundle.barrierBindingIndex ?? {})) {
    const [tdArea, address, bit] = key.split("|");
    const activeMeans = bundle.barrierBindingActiveMeans?.[key] ?? null;
    await client.query(
      `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit, active_means)
       values ($1, $2, 'td_s_bit_barrier', $3, $4, $5, $6)
       on conflict do nothing`,
      [mapVersionId, elementId, tdArea, address, bit, activeMeans],
    );
  }

  // Milestone 64 / ADR 0016: a route's bit, in its own binding_type and set/unset vocabulary
  // (migration 0042), so a route bit can never be read as a signal or barrier bit.
  for (const [key, elementId] of Object.entries(bundle.routeBindingIndex ?? {})) {
    const [tdArea, address, bit] = key.split("|");
    const activeMeans = bundle.routeBindingActiveMeans?.[key] ?? null;
    await client.query(
      `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit, active_means)
       values ($1, $2, 'td_s_bit_route', $3, $4, $5, $6)
       on conflict do nothing`,
      [mapVersionId, elementId, tdArea, address, bit, activeMeans],
    );
  }

  // Milestone 59 / ADR 0015: one row per input signal of an inferred crossing, in the signal's
  // on/off vocabulary (migration 0040). The live publisher groups them by element_id.
  for (const [elementId, inputs] of Object.entries(bundle.inferredBarrierBindings ?? {})) {
    for (const input of inputs) {
      await client.query(
        `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit, active_means)
         values ($1, $2, 'td_s_bit_barrier_input', $3, $4, $5, $6)
         on conflict do nothing`,
        [mapVersionId, elementId, input.tdArea, input.address, input.bit, input.activeMeans],
      );
    }
  }
}
