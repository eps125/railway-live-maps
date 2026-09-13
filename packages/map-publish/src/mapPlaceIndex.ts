import type { CompiledMapBundle } from "@railway/map-schema";
import type { Queryable } from "./mapBindingIndex.js";

/**
 * Milestone 31: populates `map_place_index` from a compiled bundle's `placeBindingIndex`
 * (`packages/map-schema/src/compiler.ts`) — the parallel of `insertMapBindingIndexRows` for place
 * search rather than live TD delta routing. Shared by every publish path (`publish-map` CLI, the
 * editor's publish API route).
 */
export async function insertMapPlaceIndexRows(
  client: Queryable,
  mapVersionId: string,
  bundle: CompiledMapBundle,
): Promise<void> {
  // Defensive: a malformed/placeholder bundle without this field inserts zero rows rather than
  // throwing (same convention as insertMapBindingIndexRows).
  for (const place of bundle.placeBindingIndex ?? []) {
    await client.query(
      `insert into map_place_index (map_version_id, element_id, element_type, tiploc, stanox, crs)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        mapVersionId,
        place.elementId,
        place.elementType,
        place.tiploc ?? null,
        place.stanox ?? null,
        place.crs ?? null,
      ],
    );
  }
}
