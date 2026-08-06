import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { MapDocument } from "@railway/map-schema";
import { apiError } from "../../lib/queryRange.js";
import { currentVersionForSlug } from "../../lib/mapVersion.js";
import { getDraft } from "../../editor/draftStore.js";
import { diffMapDocuments } from "../../editor/diff.js";

export interface EditorDiffRoutesDeps {
  pool: Pool;
}

/** `GET /api/v1/editor/maps/{slug}/diff?fromVersion=&toRevision=` (docs/API_CONTRACT.md §4).
 * Both query params are optional: omitted `fromVersion` compares against the currently
 * published version; omitted `toRevision` compares against the current (latest-saved) draft —
 * together, no params at all is exactly "compare a draft with the currently published version"
 * (docs/PROJECT_SPEC.md §5), the editor's primary Review-mode use case. */
export async function registerEditorDiffRoutes(
  app: FastifyInstance,
  deps: EditorDiffRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { slug: string }; Querystring: { fromVersion?: string; toRevision?: string } }>(
    "/api/v1/editor/maps/:slug/diff",
    async (request, reply) => {
      const { slug } = request.params;
      const { fromVersion, toRevision } = request.query;

      let fromDoc: MapDocument | undefined;
      if (fromVersion !== undefined) {
        const result = await pool.query<{ canonical_document: MapDocument }>(
          `select mv.canonical_document from map_version mv join map m on m.id = mv.map_id
           where m.slug = $1 and mv.version_number = $2`,
          [slug, Number(fromVersion)],
        );
        fromDoc = result.rows[0]?.canonical_document;
      } else {
        const version = await currentVersionForSlug(pool, slug, new Date());
        fromDoc = version?.canonical_document;
      }
      if (!fromDoc) {
        reply.code(404);
        return apiError(
          "MAP_VERSION_NOT_FOUND",
          "No matching published version found for comparison",
        );
      }

      let toDoc: MapDocument | undefined;
      if (toRevision !== undefined) {
        const result = await pool.query<{ canonical_document: MapDocument }>(
          `select mdr.canonical_document from map_draft_revision mdr
           join map_draft md on md.id = mdr.map_draft_id
           where md.slug = $1 and mdr.revision = $2`,
          [slug, Number(toRevision)],
        );
        toDoc = result.rows[0]?.canonical_document;
      } else {
        const draft = await getDraft(pool, slug);
        toDoc = draft?.canonical_document;
      }
      if (!toDoc) {
        reply.code(404);
        return apiError(
          "DRAFT_REVISION_NOT_FOUND",
          "No matching draft revision found for comparison",
        );
      }

      return diffMapDocuments(fromDoc, toDoc);
    },
  );
}
