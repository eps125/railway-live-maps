import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { GUEST_VIEWER, mapVisibilitySql } from "../../lib/viewer.js";

export interface EditorMapListRoutesDeps {
  pool: Pool;
}

interface EditorMapRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: "public" | "restricted";
  region_id: string | null;
  region_name: string | null;
  region_sort_order: number | null;
  group_ids: string[];
  version_number: number | null;
  published_at: Date | null;
  draft_revision: number | null;
  draft_updated_at: Date | null;
}

/**
 * Milestone 83 (docs/adr/0018): `GET /api/v1/editor/maps` — every map the signed-in user may see,
 * published or not, with its settings and publish state. Backs the editor's "Unpublished maps"
 * list on the landing page and the Admin › Maps page (an admin sees every map).
 *
 * "Unpublished changes" means the draft has been saved since the current version was published.
 * A draft seeded from the published version (revision 1) and never edited has none.
 */
export async function registerEditorMapListRoutes(
  app: FastifyInstance,
  deps: EditorMapListRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/editor/maps", async (request) => {
    const viewer = request.viewer ?? GUEST_VIEWER;
    const visible = mapVisibilitySql(viewer, "m", 1);
    const result = await pool.query<EditorMapRow>(
      `select m.id::text, m.slug, m.name, m.description, m.visibility,
              r.id::text as region_id, r.name as region_name, r.sort_order as region_sort_order,
              coalesce((select array_agg(mvg.group_id::text order by mvg.group_id)
                          from map_visibility_group mvg where mvg.map_id = m.id), '{}') as group_ids,
              cv.version_number, cv.published_at,
              d.revision as draft_revision, d.updated_at as draft_updated_at
         from map m
         left join map_region r on r.id = m.region_id
         left join lateral (
           select mv.version_number, mv.published_at
             from map_version mv
            where mv.map_id = m.id and mv.effective_from <= now()
              and (mv.effective_to is null or mv.effective_to > now())
            order by mv.effective_from desc
            limit 1
         ) cv on true
         left join map_draft d on d.slug = m.slug
        where ${visible.sql}
        order by lower(m.name), m.slug`,
      visible.params,
    );

    return {
      maps: result.rows.map((row) => {
        const published = row.published_at !== null;
        const hasUnpublishedChanges =
          row.draft_updated_at !== null &&
          (!published ||
            ((row.draft_revision ?? 1) > 1 && row.draft_updated_at > row.published_at!));
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          groupIds: row.group_ids,
          region: row.region_id
            ? { id: row.region_id, name: row.region_name!, sortOrder: row.region_sort_order! }
            : null,
          publishedVersion: row.version_number,
          publishedAt: row.published_at ? row.published_at.toISOString() : null,
          draftUpdatedAt: row.draft_updated_at ? row.draft_updated_at.toISOString() : null,
          hasUnpublishedChanges,
        };
      }),
    };
  });
}
