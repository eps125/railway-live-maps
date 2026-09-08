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

function blankDocument(slug: string): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: slug,
      name: slug,
      canvas: { width: 2000, height: 800, gridSize: 10 },
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
 * currently published version's canonical document if one exists, otherwise a blank scaffold.
 * `on conflict do update ... returning` makes the seed race-safe — two concurrent first
 * requests for the same never-before-drafted slug both get back the same, single row rather
 * than erroring or creating a duplicate.
 */
export async function getOrSeedDraft(pool: Pool, slug: string): Promise<DraftRow> {
  const existing = await pool.query<DraftRow>(`select * from map_draft where slug = $1`, [slug]);
  const found = existing.rows[0];
  if (found) return found;

  const version = await currentVersionForSlug(pool, slug, new Date());
  const doc = version ? version.canonical_document : blankDocument(slug);

  const inserted = await pool.query<DraftRow>(
    `insert into map_draft (slug, map_id, canonical_document, revision, base_map_version_id)
     values ($1, $2, $3, 1, $4)
     on conflict (slug) do update set slug = excluded.slug
     returning *`,
    [slug, version?.map_id ?? null, JSON.stringify(doc), version?.id ?? null],
  );
  return inserted.rows[0]!;
}

export async function getDraft(pool: Pool, slug: string): Promise<DraftRow | undefined> {
  const result = await pool.query<DraftRow>(`select * from map_draft where slug = $1`, [slug]);
  return result.rows[0];
}
