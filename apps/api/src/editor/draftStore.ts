import type { Pool } from "pg";
import type { MapDocument } from "@railway/map-schema";
import { currentVersionForSlug } from "../lib/mapVersion.js";

export interface DraftRow {
  id: string;
  slug: string;
  map_id: string | null;
  canonical_document: MapDocument;
  revision: number;
  base_map_version_id: string | null;
  updated_by: string | null;
  updated_at: Date;
  created_at: Date;
}

function blankDocument(slug: string, name: string): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: slug,
      name,
      // 2026-09-15 (docs/adr/0004 addendum): rowPitch went 30 -> 45, so a new map's default grid
      // scales with it (10 -> 15) to keep MAP_STYLE's rowPitch/gridSize = 3 ratio.
      canvas: { width: 2000, height: 800, gridSize: 15 },
      timezone: "Europe/London",
    },
    // ADR 0005 E3: a fresh map starts with the conventional layer stack so tracks, platforms,
    // platform numbers, berths, signals and labels each land where a human expects (see
    // EditorCanvas.tsx defaultLayerIdForTool). Existing drafts are untouched.
    layers: [
      { id: "layer-track", name: "Track", visible: true, locked: false, order: 0 },
      { id: "layer-platforms", name: "Platforms", visible: true, locked: false, order: 1 },
      { id: "layer-berths", name: "Berths", visible: true, locked: false, order: 2 },
      { id: "layer-signals", name: "Signals", visible: true, locked: false, order: 3 },
      { id: "layer-labels", name: "Labels", visible: true, locked: false, order: 4 },
    ],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

/**
 * Fetches the draft for a slug, seeding a fresh one (revision 1) on first access: from the
 * currently published version's canonical document if one exists; otherwise, if the slug already
 * has a `map` row (Milestone 30's `POST /api/v1/editor/maps` creates one before a first publish
 * ever happens), a blank scaffold named after that map; otherwise a blank scaffold named after the
 * slug itself. `on conflict do update ... returning` makes the seed race-safe — two concurrent
 * first requests for the same never-before-drafted slug both get back the same, single row rather
 * than erroring or creating a duplicate.
 */
export async function getOrSeedDraft(pool: Pool, slug: string): Promise<DraftRow> {
  const existing = await pool.query<DraftRow>(`select * from map_draft where slug = $1`, [slug]);
  const found = existing.rows[0];
  if (found) return found;

  const version = await currentVersionForSlug(pool, slug, new Date());
  let mapId = version?.map_id ?? null;
  let doc = version?.canonical_document;

  if (!doc) {
    const mapRow = await pool.query<{ id: string; name: string }>(
      `select id, name from map where slug = $1`,
      [slug],
    );
    const map = mapRow.rows[0];
    mapId = map?.id ?? null;
    doc = blankDocument(slug, map?.name ?? slug);
  }

  const inserted = await pool.query<DraftRow>(
    `insert into map_draft (slug, map_id, canonical_document, revision, base_map_version_id)
     values ($1, $2, $3, 1, $4)
     on conflict (slug) do update set slug = excluded.slug
     returning *`,
    [slug, mapId, JSON.stringify(doc), version?.id ?? null],
  );
  return inserted.rows[0]!;
}

export async function getDraft(pool: Pool, slug: string): Promise<DraftRow | undefined> {
  const result = await pool.query<DraftRow>(`select * from map_draft where slug = $1`, [slug]);
  return result.rows[0];
}
