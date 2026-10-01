import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { isAssembledMap, MapDocumentSchema } from "@railway/map-schema";
import { publishMapVersion, EFFECTIVE_FROM_ALL_TIME } from "@railway/map-publish";
import { apiError } from "../../lib/queryRange.js";
import { validateDraftInContext } from "../../editor/validateWithContext.js";
import { getDraft } from "../../editor/draftStore.js";
import { audit } from "../../lib/audit.js";
import {
  assembleFromPublished,
  cascadeModulePublish,
  mapKindForSlug,
  moduleIssuesAsValidation,
  publishAssembledVersion,
  publishModuleVersion,
  type Assembly,
} from "../../editor/modules.js";

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

      // Owner decision 2026-09-11 (docs/IMPLEMENTATION_PLAN.md): a publish that doesn't specify
      // effectiveFrom applies retroactively to all playback rather than defaulting to "now", so
      // playback always reflects the latest published map without the author having to remember
      // to backdate every publish. Pass an explicit effectiveFrom for a genuine time-scoped
      // historical version.
      const effectiveFrom = body.effectiveFrom
        ? new Date(body.effectiveFrom)
        : EFFECTIVE_FROM_ALL_TIME;
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

      // Milestone 85 (docs/adr/0019): a module publishes a module version and then republishes
      // every map assembled from it; an assembled map publishes its flattened document, built
      // from each module's latest published version.
      const kind = await mapKindForSlug(pool, slug);
      const source = parsed.data;
      if (kind === "module" && isAssembledMap(source)) {
        reply.code(422);
        return apiError("VALIDATION_FAILED", "A module can't itself be made of modules", {
          errors: [{ code: "module_nested", message: "Remove the modules from this module" }],
        });
      }
      let assembly: Assembly | null = null;
      if (kind !== "module" && isAssembledMap(source)) {
        assembly = await assembleFromPublished(pool, source);
        if (assembly.issues.length > 0) {
          reply.code(422);
          return apiError("VALIDATION_FAILED", "The map's modules don't fit together", {
            errors: moduleIssuesAsValidation(assembly.issues),
          });
        }
      }
      const validation = await validateDraftInContext(pool, assembly?.flattened ?? source);
      if (!validation.valid) {
        reply.code(422);
        return apiError("VALIDATION_FAILED", "Draft has publication-blocking validation errors", {
          errors: validation.errors,
        });
      }
      const publishedBy = request.authSession?.username ?? body.publishedBy ?? "editor";

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

        if (kind === "module") {
          const moduleVersion = await publishModuleVersion(client, {
            slug,
            doc: source,
            publishedBy,
          });
          await client.query(`update map_draft set map_id = $1 where slug = $2`, [
            moduleVersion.mapId,
            slug,
          ]);
          await audit(
            client,
            request,
            "module.publish",
            { type: "map", id: moduleVersion.mapId },
            {
              slug,
              versionNumber: moduleVersion.versionNumber,
              draftRevision: body.expectedRevision,
            },
          );
          await client.query("commit");

          // After the module version is safely committed: every map assembled from it, each in
          // its own transaction.
          const cascade = await cascadeModulePublish(pool, slug, `${publishedBy} (module ${slug})`);
          if (cascade.length > 0) {
            await audit(
              pool,
              request,
              "module.cascade",
              { type: "map", id: moduleVersion.mapId },
              {
                slug,
                versionNumber: moduleVersion.versionNumber,
                maps: cascade,
              },
            );
          }
          return {
            kind: "module" as const,
            mapId: moduleVersion.mapId,
            moduleVersionId: moduleVersion.moduleVersionId,
            versionNumber: moduleVersion.versionNumber,
            cascade,
          };
        }

        const result = assembly
          ? await publishAssembledVersion(client, {
              slug,
              source,
              assembly,
              effectiveFrom,
              publishedBy,
            })
          : await publishMapVersion(client, {
              slug,
              doc: source,
              effectiveFrom,
              // Milestone 83: the signed-in user, so the version and the audit log agree.
              publishedBy,
            });

        await client.query(
          `update map_draft set map_id = $1, base_map_version_id = $2 where slug = $3`,
          [result.mapId, result.mapVersionId, slug],
        );
        await audit(
          client,
          request,
          "map.publish",
          { type: "map", id: result.mapId },
          {
            slug,
            versionNumber: result.versionNumber,
            draftRevision: body.expectedRevision,
            effectiveFrom: effectiveFrom.toISOString(),
            ...(assembly ? { modules: assembly.moduleVersions } : {}),
          },
        );

        await client.query("commit");
        return {
          kind: "map" as const,
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
