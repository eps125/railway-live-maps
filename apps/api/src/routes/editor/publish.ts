import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { MapDocumentSchema } from "@railway/map-schema";
import { publishMapVersion } from "@railway/map-publish";
import { apiError } from "../../lib/queryRange.js";
import { validateDraftInContext } from "../../editor/validateWithContext.js";
import { getDraft } from "../../editor/draftStore.js";

export interface EditorPublishRoutesDeps {
  pool: Pool;
}

interface PublishBody {
  expectedRevision: number;
  effectiveFrom?: string;
  publishedBy?: string;
}

/**
 * `POST /api/v1/editor/maps/{slug}/publish` (docs/API_CONTRACT.md §4). The "immutable publish
 * with effective date" step of the version lifecycle (docs/MAP_EDITOR_SPEC.md §11:
 * `Draft -> Validated -> Published -> Superseded -> Archived`). Gates on the same optimistic
 * lock as `PUT .../draft` (a stale `expectedRevision` 409s rather than publishing something the
 * author hasn't actually seen) and on `validateDraftInContext`'s blocking errors (a failing
 * validation never reaches `publishMapVersion` — publication-blocking is enforced server-side,
 * not just in the editor UI). Delegates persistence to the same `@railway/map-publish` package
 * the `publish-map` CLI uses, inside its own transaction so the optimistic-lock re-check and
 * the actual version insert are atomic.
 */
export async function registerEditorPublishRoutes(
  app: FastifyInstance,
  deps: EditorPublishRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.post<{ Params: { slug: string }; Body: PublishBody }>(
    "/api/v1/editor/maps/:slug/publish",
    async (request, reply) => {
      const { slug } = request.params;
      const body = request.body;

      if (typeof body?.expectedRevision !== "number") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "expectedRevision (number) is required");
      }

      const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
      if (Number.isNaN(effectiveFrom.getTime())) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", "effectiveFrom must be a valid ISO 8601 timestamp");
      }

      const draft = await getDraft(pool, slug);
      if (!draft) {
        reply.code(404);
        return apiError("DRAFT_NOT_FOUND", `No draft exists for "${slug}" yet`);
      }

      const parsed = MapDocumentSchema.safeParse(draft.canonical_document);
      if (!parsed.success) {
        reply.code(422);
        return apiError("VALIDATION_FAILED", "Draft document failed schema validation", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      const validation = await validateDraftInContext(pool, parsed.data);
      if (!validation.valid) {
        reply.code(422);
        return apiError("VALIDATION_FAILED", "Draft has publication-blocking validation errors", {
          errors: validation.errors,
        });
      }

      const client = await pool.connect();
      try {
        await client.query("begin");

        // Re-check the optimistic lock inside the transaction, with a row lock, so a
        // concurrent PUT/publish can't slip in between this check and the actual publish.
        const lockResult = await client.query<{ revision: number }>(
          `select revision from map_draft where slug = $1 for update`,
          [slug],
        );
        const currentRevision = lockResult.rows[0]?.revision;
        if (currentRevision !== body.expectedRevision) {
          await client.query("rollback");
          reply.code(409);
          return apiError(
            "DRAFT_REVISION_CONFLICT",
            "The draft has changed since your expectedRevision — reload and retry",
            { currentRevision: currentRevision ?? null },
          );
        }

        const result = await publishMapVersion(client, {
          slug,
          doc: parsed.data,
          effectiveFrom,
          publishedBy: body.publishedBy ?? "editor",
        });

        await client.query(
          `update map_draft set map_id = $1, base_map_version_id = $2 where slug = $3`,
          [result.mapId, result.mapVersionId, slug],
        );

        await client.query("commit");
        return {
          mapId: result.mapId,
          mapVersionId: result.mapVersionId,
          versionNumber: result.versionNumber,
          checksum: result.checksum,
          effectiveFrom: effectiveFrom.toISOString(),
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
