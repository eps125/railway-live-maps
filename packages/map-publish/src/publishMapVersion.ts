import { createHash } from "node:crypto";
import {
  compileMapDocument,
  computeBoundingBox,
  type MapDocument,
  type CompiledMapBundle,
} from "@railway/map-schema";
import { insertMapBindingIndexRows, type Queryable } from "./mapBindingIndex.js";

/** Matches apps/web/src/map/MapRenderer.tsx's own PADDING/MIN_ZOOM_WIDTH constants — same
 * "pad the real content a bit, floor it at a sane minimum" convention, applied here so a
 * published map_version's stored canvas.width/height reflects what's actually on the map rather
 * than whatever value the document happened to be created with. Nothing downstream currently
 * reads canvas.width/height for positioning (the editor's own grid follows the viewport, not
 * this field, and the public renderer never reads it at all) — this exists so the field stays a
 * meaningful, truthful size rather than a stale leftover, in case a future consumer wants it. */
const CANVAS_TRIM_PADDING = 40;
const MIN_CANVAS_DIMENSION = 100;

/** Recomputes canvas.width/height to fit the document's real element bounding box (with
 * padding), leaving gridSize untouched — an editor working on an "infinite" canvas (grid follows
 * the viewport, not a fixed pre-set size) never has to manually resize it, and publishing is what
 * trims the excess. Computed from `doc.elements` directly (the same way `compileMapDocument`
 * will) *before* compiling, so the trimmed doc and the bundle compiled from it stay consistent —
 * `compileMapDocument` passes `canvas` straight through unchanged, so trimming after compiling
 * would leave the canonical document and the compiled bundle disagreeing with each other. */
export function trimCanvasToContent(doc: MapDocument): MapDocument {
  const { minX, minY, maxX, maxY } = computeBoundingBox(doc.elements);
  return {
    ...doc,
    map: {
      ...doc.map,
      canvas: {
        ...doc.map.canvas,
        width: Math.max(maxX - minX + CANVAS_TRIM_PADDING * 2, MIN_CANVAS_DIMENSION),
        height: Math.max(maxY - minY + CANVAS_TRIM_PADDING * 2, MIN_CANVAS_DIMENSION),
      },
    },
  };
}

export interface PublishMapVersionInput {
  slug: string;
  /** Already schema-validated (`validateMapDocument`) and parsed (`MapDocumentSchema.parse`)
   * by the caller — this function only compiles and persists, it never re-validates. */
  doc: MapDocument;
  effectiveFrom: Date;
  publishedBy: string;
}

export interface PublishMapVersionResult {
  mapId: string;
  mapVersionId: string;
  versionNumber: number;
  bundle: CompiledMapBundle;
  checksum: string;
}

/**
 * Core publish transaction body, extracted from what was originally the `publish-map` CLI's
 * inline logic (Milestone 5) so both the CLI *and* the editor's publish API route (Milestone
 * 12) call exactly one implementation. The caller owns the transaction boundary
 * (`begin`/`commit`/`rollback`) so it can wrap this with its own pre-checks — e.g. the editor
 * route's validation gate and optimistic-lock check — in the same atomic unit.
 *
 * Upserts `map` by slug, closes out whichever `map_version` was previously open-ended (keeps
 * the `map_version_no_overlap` exclusion constraint from migration 0009 satisfied), inserts
 * the new immutable version, and populates its `map_binding_index` rows.
 */
export async function publishMapVersion(
  client: Queryable,
  input: PublishMapVersionInput,
): Promise<PublishMapVersionResult> {
  const { slug, effectiveFrom, publishedBy } = input;
  const doc = trimCanvasToContent(input.doc);
  const bundle = compileMapDocument(doc);
  const canonicalJson = JSON.stringify(doc);
  const checksum = createHash("sha256").update(canonicalJson).digest("hex");

  const mapResult = await client.query<{ id: string }>(
    `insert into map (slug, name)
     values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id`,
    [slug, doc.map.name],
  );
  const mapId = mapResult.rows[0]?.id;
  if (!mapId) {
    throw new Error("Expected map upsert to return an id");
  }

  const versionNumberResult = await client.query<{ next: string }>(
    `select coalesce(max(version_number), 0) + 1 as next from map_version where map_id = $1`,
    [mapId],
  );
  const versionNumber = Number(versionNumberResult.rows[0]?.next ?? "1");

  // Close out whichever version was previously open-ended, so the new version's
  // [effective_from, null) range doesn't overlap it.
  await client.query(
    `update map_version set effective_to = $2 where map_id = $1 and effective_to is null`,
    [mapId, effectiveFrom],
  );

  const inserted = await client.query<{ id: string; version_number: number }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, effective_to, published_by, schema_version, checksum
     ) values ($1,$2,$3,$4,$5,null,$6,$7,$8)
     returning id, version_number`,
    [
      mapId,
      versionNumber,
      canonicalJson,
      JSON.stringify(bundle),
      effectiveFrom,
      publishedBy,
      doc.schemaVersion,
      checksum,
    ],
  );

  const mapVersionId = inserted.rows[0]?.id;
  if (!mapVersionId) {
    throw new Error("Expected map_version insert to return an id");
  }
  await insertMapBindingIndexRows(client, mapVersionId, bundle);

  return { mapId, mapVersionId, versionNumber, bundle, checksum };
}
