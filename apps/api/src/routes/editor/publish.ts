import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  isAssembledMap,
  MapDocumentSchema,
  moduleSlugs,
  type MapDocument,
  type ValidationIssue,
} from "@railway/map-schema";
import { publishMapVersion, EFFECTIVE_FROM_ALL_TIME } from "@railway/map-publish";
import { apiError } from "../../lib/queryRange.js";
import { validateDraftInContext } from "../../editor/validateWithContext.js";
import { getDraft } from "../../editor/draftStore.js";
import { audit } from "../../lib/audit.js";
import {
  assembleFromPublished,
  cascadeInTransaction,
  cascadeModulePublish,
  mapKindForSlug,
  moduleChanges,
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
  /** Milestone 96: modules of this assembled map to publish with it, each at the draft revision
   * the author saw. Omitted or empty: the map only, against the modules' published versions. */
  publishModules?: unknown;
}

interface ModuleToPublish {
  slug: string;
  expectedRevision: number;
}

/** A module draft that passed every check, ready to publish inside the map's transaction. */
interface CheckedModule extends ModuleToPublish {
  doc: MapDocument;
}

/** `null` for a malformed list. */
export function parsePublishModules(value: unknown): ModuleToPublish[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: ModuleToPublish[] = [];
  for (const item of value) {
    const entry = item as { slug?: unknown; expectedRevision?: unknown } | null;
    if (typeof entry?.slug !== "string" || typeof entry.expectedRevision !== "number") return null;
    if (out.some((m) => m.slug === entry.slug)) return null;
    out.push({ slug: entry.slug, expectedRevision: entry.expectedRevision });
  }
  return out;
}

function moduleConflict(slug: string, currentRevision: number | null) {
  return apiError(
    "DRAFT_REVISION_CONFLICT",
    `Module ${slug} has changed since you looked — reload and retry`,
    { moduleSlug: slug, currentRevision },
  );
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
 *
 * Milestone 96 (docs/adr/0019 amendment): an assembled map may publish some of its modules'
 * drafts with it (`publishModules`), all in that one transaction, and
 * `GET .../module-changes` says which modules have something to publish.
 */
export async function registerEditorPublishRoutes(
  app: FastifyInstance,
  deps: EditorPublishRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  // Milestone 96: which of an assembled map's modules have a draft not yet published — what the
  // publish UI offers to publish with the map. `[]` for a module or a map without modules.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/editor/maps/:slug/module-changes",
    async (request, reply) => {
      const { slug } = request.params;
      const draft = await getDraft(pool, slug);
      if (!draft) {
        reply.code(404);
        return apiError("DRAFT_NOT_FOUND", `No draft exists for "${slug}" yet`);
      }
      const parsed = MapDocumentSchema.safeParse(draft.canonical_document);
      if (!parsed.success || !isAssembledMap(parsed.data)) return { modules: [] };
      if ((await mapKindForSlug(pool, slug)) === "module") return { modules: [] };
      return { modules: await moduleChanges(pool, moduleSlugs(parsed.data)) };
    },
  );

  app.post<{ Params: { slug: string }; Body: PublishBody }>(
    "/api/v1/editor/maps/:slug/publish",
    async (request, reply) => {
      const { slug } = request.params;
      const body = request.body;

      if (typeof body?.expectedRevision !== "number") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "expectedRevision (number) is required");
      }
      const requestedModules = parsePublishModules(body.publishModules);
      if (!requestedModules) {
        reply.code(400);
        return apiError(
          "VALIDATION_ERROR",
          "publishModules must be a list of distinct { slug, expectedRevision }",
        );
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
      if (requestedModules.length > 0 && (kind === "module" || !isAssembledMap(source))) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "Only an assembled map can publish modules with it");
      }

      // Milestone 96: modules published with the map. Each must be one of the map's modules, at
      // the draft revision the author saw, and a valid module on its own; one whose draft matches
      // its latest published version has nothing to publish and is skipped.
      const withModules: CheckedModule[] = [];
      if (requestedModules.length > 0) {
        const listed = new Set(moduleSlugs(source));
        const notListed = requestedModules.filter((m) => !listed.has(m.slug));
        if (notListed.length > 0) {
          reply.code(400);
          return apiError(
            "VALIDATION_ERROR",
            `Not a module of this map: ${notListed.map((m) => m.slug).join(", ")}`,
          );
        }
        const changes = new Map(
          (
            await moduleChanges(
              pool,
              requestedModules.map((m) => m.slug),
            )
          ).map((change) => [change.slug, change]),
        );
        const moduleErrors: ValidationIssue[] = [];
        for (const requested of requestedModules) {
          const change = changes.get(requested.slug);
          if (!change || change.status === "missing") {
            moduleErrors.push({
              code: "module_missing",
              message: `Module ${requested.slug} doesn't exist or has no draft`,
            });
            continue;
          }
          if (change.status === "unchanged") continue;
          const moduleDraft = await getDraft(pool, requested.slug);
          if (!moduleDraft || moduleDraft.revision !== requested.expectedRevision) {
            reply.code(409);
            return moduleConflict(requested.slug, moduleDraft?.revision ?? null);
          }
          const moduleParsed = MapDocumentSchema.safeParse(moduleDraft.canonical_document);
          if (!moduleParsed.success) {
            moduleErrors.push({
              code: "invalid_schema",
              message: `Module ${requested.slug}: the draft doesn't parse`,
            });
            continue;
          }
          if (isAssembledMap(moduleParsed.data)) {
            moduleErrors.push({
              code: "module_nested",
              message: `Module ${requested.slug}: a module can't itself be made of modules`,
            });
            continue;
          }
          // The same check publishing the module on its own makes.
          const moduleValidation = await validateDraftInContext(pool, moduleParsed.data);
          moduleErrors.push(
            ...moduleValidation.errors.map((issue) => ({
              ...issue,
              message: `Module ${requested.slug}: ${issue.message}`,
            })),
          );
          withModules.push({ ...requested, doc: moduleParsed.data });
        }
        if (moduleErrors.length > 0) {
          reply.code(422);
          return apiError("VALIDATION_FAILED", "A module to publish with the map has errors", {
            errors: moduleErrors,
          });
        }
      }

      let assembly: Assembly | null = null;
      if (kind !== "module" && isAssembledMap(source)) {
        assembly = await assembleFromPublished(
          pool,
          source,
          new Map(withModules.map((m) => [m.slug, m.doc])),
        );
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

        // Milestone 96: the modules first, each re-checked against its draft revision under a row
        // lock (in slug order, so two publishes sharing modules can't deadlock), then the map is
        // assembled again from what is now published — the module versions it records.
        const publishedModules: Array<{
          slug: string;
          moduleVersionId: string;
          versionNumber: number;
        }> = [];
        for (const module of [...withModules].sort((a, b) => a.slug.localeCompare(b.slug))) {
          const moduleLock = await client.query<{ revision: number }>(
            `select revision from map_draft where slug = $1 for update`,
            [module.slug],
          );
          const moduleRevision = moduleLock.rows[0]?.revision ?? null;
          if (moduleRevision !== module.expectedRevision) {
            await client.query("rollback");
            reply.code(409);
            return moduleConflict(module.slug, moduleRevision);
          }
          const moduleVersion = await publishModuleVersion(client, {
            slug: module.slug,
            doc: module.doc,
            publishedBy,
          });
          await client.query(`update map_draft set map_id = $1 where slug = $2`, [
            moduleVersion.mapId,
            module.slug,
          ]);
          await audit(
            client,
            request,
            "module.publish",
            { type: "map", id: moduleVersion.mapId },
            {
              slug: module.slug,
              versionNumber: moduleVersion.versionNumber,
              draftRevision: module.expectedRevision,
              withMap: slug,
            },
          );
          publishedModules.push({
            slug: module.slug,
            moduleVersionId: moduleVersion.moduleVersionId,
            versionNumber: moduleVersion.versionNumber,
          });
        }
        if (assembly && publishedModules.length > 0) {
          assembly = await assembleFromPublished(client, source);
          if (assembly.issues.length > 0) {
            await client.query("rollback");
            reply.code(422);
            return apiError("VALIDATION_FAILED", "The map's modules don't fit together", {
              errors: moduleIssuesAsValidation(assembly.issues),
            });
          }
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
            ...(publishedModules.length > 0 ? { publishedModules } : {}),
          },
        );

        // ADR 0019 §4: every other map assembled from a module just published is republished —
        // in this same transaction, once each, and never this map a second time.
        const cascade =
          publishedModules.length > 0
            ? await cascadeInTransaction(
                client,
                publishedModules.map((m) => m.slug),
                slug,
                `${publishedBy} (with map ${slug})`,
              )
            : [];
        if (cascade.length > 0) {
          await audit(
            client,
            request,
            "module.cascade",
            { type: "map", id: result.mapId },
            { slug, modules: publishedModules.map((m) => m.slug), maps: cascade },
          );
        }

        await client.query("commit");
        return {
          kind: "map" as const,
          mapId: result.mapId,
          mapVersionId: result.mapVersionId,
          versionNumber: result.versionNumber,
          checksum: result.checksum,
          effectiveFrom: effectiveFrom.toISOString(),
          modules: publishedModules.map((m) => ({ slug: m.slug, versionNumber: m.versionNumber })),
          cascade,
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
