import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { extractModule, MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";
import { GUEST_VIEWER, mapVisibilitySql } from "../../lib/viewer.js";
import { getDraft } from "../../editor/draftStore.js";
import {
  inTransaction,
  mapKindForSlug,
  republishMap,
  type RepublishOutcome,
} from "../../editor/modules.js";

export interface ModuleRoutesDeps {
  pool: Pool;
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Milestone 85 (docs/adr/0019): `GET /api/v1/editor/modules?slugs=a,b` — the modules an assembled
 * map uses, as the editor needs them: each module's draft (what the assembled map previews with)
 * and its latest published version (what a publish would use). Editor scope; only modules the
 * viewer may see.
 */
export async function registerEditorModuleRoutes(
  app: FastifyInstance,
  deps: ModuleRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Querystring: { slugs?: string } }>("/api/v1/editor/modules", async (request) => {
    const slugs = (request.query.slugs ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (slugs.length === 0) return { modules: [] };
    const visible = mapVisibilitySql(request.viewer ?? GUEST_VIEWER, "m", 2);
    const { rows } = await pool.query<{
      slug: string;
      name: string;
      draft: MapDocument | null;
      draft_revision: number | null;
      published: MapDocument | null;
      published_version: number | null;
    }>(
      `select m.slug, m.name, d.canonical_document as draft, d.revision as draft_revision,
              mmv.canonical_document as published, mmv.version_number as published_version
         from map m
         left join map_draft d on d.slug = m.slug
         left join lateral (
           select canonical_document, version_number from map_module_version
            where map_id = m.id order by version_number desc limit 1
         ) mmv on true
        where m.kind = 'module' and m.slug = any($1::text[]) and ${visible.sql}`,
      [slugs, ...visible.params],
    );
    return {
      modules: rows.map((row) => {
        const draft = row.draft ? MapDocumentSchema.safeParse(row.draft) : null;
        const published = row.published ? MapDocumentSchema.safeParse(row.published) : null;
        return {
          slug: row.slug,
          name: row.name,
          draft: draft?.success ? draft.data : null,
          draftRevision: row.draft_revision,
          published: published?.success ? published.data : null,
          publishedVersion: row.published_version,
        };
      }),
    };
  });
}

/**
 * Milestone 85, admin only:
 * - `POST /api/v1/editor/maps/{slug}/extract-module` `{ elementIds, moduleSlug, moduleName,
 *   expectedRevision }` — make a module from the selected elements of a map's draft (see
 *   `extractModule`), placed so nothing moves. The new module needs publishing before the map can
 *   publish again.
 * - `POST /api/v1/admin/maps/republish-all` — republish every published map from what it last
 *   published (assembled maps with their modules' latest versions). For after a compiler change.
 */
export async function registerAdminModuleRoutes(
  app: FastifyInstance,
  deps: ModuleRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.post<{
    Params: { slug: string };
    Body: {
      elementIds?: unknown;
      moduleSlug?: unknown;
      moduleName?: unknown;
      expectedRevision?: unknown;
    };
  }>("/api/v1/editor/maps/:slug/extract-module", async (request, reply) => {
    const { slug } = request.params;
    const { elementIds, moduleSlug, moduleName, expectedRevision } = request.body ?? {};
    if (
      !Array.isArray(elementIds) ||
      elementIds.length === 0 ||
      elementIds.some((id) => typeof id !== "string")
    ) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "elementIds must be a non-empty array of element ids");
    }
    if (typeof moduleSlug !== "string" || !SLUG_PATTERN.test(moduleSlug)) {
      reply.code(400);
      return apiError(
        "VALIDATION_ERROR",
        "moduleSlug must be lowercase letters, digits and single hyphens",
      );
    }
    if (typeof moduleName !== "string" || !moduleName.trim()) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "moduleName is required");
    }
    if (typeof expectedRevision !== "number") {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "expectedRevision (number) is required");
    }
    if ((await mapKindForSlug(pool, slug)) === "module") {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "A module can't be split into modules");
    }
    const draft = await getDraft(pool, slug);
    if (!draft) {
      reply.code(404);
      return apiError("DRAFT_NOT_FOUND", `No draft exists for "${slug}" yet`);
    }
    const parsed = MapDocumentSchema.safeParse(draft.canonical_document);
    if (!parsed.success) {
      reply.code(422);
      return apiError("VALIDATION_FAILED", "The draft doesn't parse");
    }
    const result = extractModule(parsed.data, elementIds as string[], {
      slug: moduleSlug,
      name: moduleName.trim(),
    });
    if (result.moduleDoc.elements.length === 0) {
      reply.code(400);
      return apiError(
        "VALIDATION_ERROR",
        "Nothing could move: every selected element refers to something outside the selection",
        { keptInMap: result.keptInMap },
      );
    }

    try {
      const outcome = await inTransaction(pool, async (client) => {
        const created = await client.query<{ id: string }>(
          `insert into map (slug, name, kind) values ($1, $2, 'module')
           on conflict (slug) do nothing returning id::text`,
          [moduleSlug, moduleName.trim()],
        );
        const moduleId = created.rows[0]?.id;
        if (!moduleId) return { conflict: "slug" as const };
        // The module inherits the map's visibility, so extracting never widens who sees what.
        await client.query(
          `update map m set visibility = src.visibility, region_id = src.region_id
             from map src where m.id = $1 and src.slug = $2`,
          [moduleId, slug],
        );
        await client.query(
          `insert into map_visibility_group (map_id, group_id)
           select $1, mvg.group_id from map_visibility_group mvg join map src on src.id = mvg.map_id
            where src.slug = $2`,
          [moduleId, slug],
        );
        const moduleJson = JSON.stringify(result.moduleDoc);
        const moduleDraft = await client.query<{ id: string }>(
          `insert into map_draft (slug, map_id, canonical_document, revision, updated_by)
           values ($1, $2, $3, 1, $4) returning id::text`,
          [moduleSlug, moduleId, moduleJson, request.authSession?.username ?? null],
        );
        await client.query(
          `insert into map_draft_revision (map_draft_id, revision, canonical_document, author, comment)
           values ($1, 1, $2, $3, $4)`,
          [
            moduleDraft.rows[0]!.id,
            moduleJson,
            request.authSession?.username ?? null,
            `Made from ${slug}`,
          ],
        );

        const remainingJson = JSON.stringify(result.remainingDoc);
        const updated = await client.query<{ id: string; revision: number }>(
          `update map_draft
              set canonical_document = $1, revision = revision + 1, updated_by = $2, updated_at = now()
            where slug = $3 and revision = $4
            returning id::text, revision`,
          [remainingJson, request.authSession?.username ?? null, slug, expectedRevision],
        );
        const row = updated.rows[0];
        if (!row) throw new RevisionConflict();
        await client.query(
          `insert into map_draft_revision (map_draft_id, revision, canonical_document, author, comment)
           values ($1, $2, $3, $4, $5)`,
          [
            row.id,
            row.revision,
            remainingJson,
            request.authSession?.username ?? null,
            `Moved ${result.moduleDoc.elements.length} elements into module ${moduleSlug}`,
          ],
        );
        await audit(
          client,
          request,
          "module.extract",
          { type: "map", id: moduleId },
          {
            from: slug,
            module: moduleSlug,
            elements: result.moduleDoc.elements.length,
            keptInMap: result.keptInMap,
          },
        );
        return { revision: row.revision };
      });
      if ("conflict" in outcome) {
        reply.code(409);
        return apiError(
          "DUPLICATE_SLUG",
          `A map or module with slug "${moduleSlug}" already exists`,
        );
      }
      return {
        moduleSlug,
        movedElements: result.moduleDoc.elements.length,
        keptInMap: result.keptInMap,
        revision: outcome.revision,
        canonicalDocument: result.remainingDoc,
      };
    } catch (error) {
      if (error instanceof RevisionConflict) {
        reply.code(409);
        return apiError(
          "DRAFT_REVISION_CONFLICT",
          "The draft has changed since your expectedRevision — reload and retry",
        );
      }
      throw error;
    }
  });

  app.post("/api/v1/admin/maps/republish-all", async (request) => {
    const { rows } = await pool.query<{ slug: string }>(
      `select distinct m.slug from map m join map_version mv on mv.map_id = m.id
        where m.kind = 'map' and mv.effective_from <= now()
          and (mv.effective_to is null or mv.effective_to > now())
        order by m.slug`,
    );
    const by = `${request.authSession?.username ?? "admin"} (republish all)`;
    const outcomes: RepublishOutcome[] = [];
    for (const { slug } of rows) {
      try {
        outcomes.push(await inTransaction(pool, (client) => republishMap(client, slug, by)));
      } catch (error) {
        outcomes.push({
          slug,
          ok: false,
          errors: [{ code: "republish_failed", message: (error as Error).message }],
        });
      }
    }
    await audit(pool, request, "map.republish_all", null, { maps: outcomes });
    return { maps: outcomes };
  });
}

class RevisionConflict extends Error {}
