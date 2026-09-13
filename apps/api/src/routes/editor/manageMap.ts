import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError } from "../../lib/queryRange.js";

export interface ManageMapRouteDeps {
  pool: Pool;
}

interface RenameMapBody {
  name?: unknown;
  slug?: unknown;
}

/** Same pattern as `createMap.ts` — lowercase, hyphen-separated, safe unencoded in a URL path
 * segment. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A Postgres unique-violation error, distinguished from any other query failure so a duplicate
 * slug maps to 409 rather than a 500. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

/**
 * Owner request (2026-09-13, quick follow-up alongside Milestone 32): rename a map's
 * name/slug, or delete it outright. Admin-only, same encapsulated scope as `createMap.ts`
 * (`server.ts`'s `adminMapScope`).
 */
export async function registerManageMapRoutes(
  app: FastifyInstance,
  deps: ManageMapRouteDeps,
): Promise<void> {
  const { pool } = deps;

  app.patch<{ Params: { slug: string }; Body: RenameMapBody }>(
    "/api/v1/editor/maps/:slug",
    async (request, reply) => {
      const { slug: currentSlug } = request.params;
      const { name, slug: newSlugRaw } = request.body ?? {};

      if (name === undefined && newSlugRaw === undefined) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "at least one of name or slug is required");
      }
      if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "name, if given, must be a non-empty string");
      }
      if (
        newSlugRaw !== undefined &&
        (typeof newSlugRaw !== "string" || !SLUG_PATTERN.test(newSlugRaw))
      ) {
        reply.code(400);
        return apiError(
          "VALIDATION_ERROR",
          "slug, if given, must be lowercase letters, digits and single hyphens only",
        );
      }
      const newSlug = newSlugRaw as string | undefined;

      const client = await pool.connect();
      try {
        await client.query("begin");

        const updated = await client.query<{ id: string; slug: string; name: string }>(
          `update map
             set name = coalesce($1, name),
                 slug = coalesce($2, slug)
           where slug = $3
           returning id, slug, name`,
          [name ?? null, newSlug ?? null, currentSlug],
        );
        const mapRow = updated.rows[0];
        if (!mapRow) {
          await client.query("rollback");
          reply.code(404);
          return apiError("MAP_NOT_FOUND", `No map with slug "${currentSlug}" exists`);
        }

        // The draft's own `slug` column is denormalized (not derived from `map.slug` at read
        // time — see `draftStore.ts`), and `canonical_document.map.id`/`map.name` are the
        // document-internal fields the editor's own Properties panel edits (docs/
        // MAP_EDITOR_SPEC.md "Map metadata") — keep both in sync so the next draft save/publish,
        // and the editor UI if it's open, see the new values rather than reverting them.
        if (newSlug || name) {
          await client.query(
            `update map_draft
               set slug = coalesce($1, slug),
                   canonical_document = jsonb_set(
                     jsonb_set(canonical_document, '{map,id}', to_jsonb(coalesce($1, slug)::text)),
                     '{map,name}', to_jsonb(coalesce($2, canonical_document->'map'->>'name')::text)
                   )
             where slug = $3`,
            [newSlug ?? null, name ?? null, currentSlug],
          );
        }

        await client.query("commit");
        return { mapId: mapRow.id, slug: mapRow.slug, name: mapRow.name };
      } catch (error) {
        await client.query("rollback");
        if (isUniqueViolation(error)) {
          reply.code(409);
          return apiError("DUPLICATE_SLUG", `A map with slug "${newSlug}" already exists`);
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { slug: string } }>("/api/v1/editor/maps/:slug", async (request, reply) => {
    const { slug } = request.params;

    const client = await pool.connect();
    try {
      await client.query("begin");

      const mapRow = await client.query<{ id: string }>(`select id from map where slug = $1`, [
        slug,
      ]);
      const mapId = mapRow.rows[0]?.id;
      if (!mapId) {
        await client.query("rollback");
        reply.code(404);
        return apiError("MAP_NOT_FOUND", `No map with slug "${slug}" exists`);
      }

      // Manual cascade in dependency order — none of these FKs are ON DELETE CASCADE (deletion
      // is meant to be rare and deliberate, not an accidental side effect of some other delete).
      // This never touches nationwide TD/TRUST/etc. event tables (CLAUDE.md rule 17: a map's
      // absence must not affect capture/history for its area) — only this map's own
      // configuration, drafts and published versions.
      await client.query(
        `delete from map_state_snapshot where map_version_id in (select id from map_version where map_id = $1)`,
        [mapId],
      );
      await client.query(
        `delete from map_binding_index where map_version_id in (select id from map_version where map_id = $1)`,
        [mapId],
      );
      await client.query(
        `delete from map_place_index where map_version_id in (select id from map_version where map_id = $1)`,
        [mapId],
      );
      await client.query(
        `delete from map_draft_revision where map_draft_id in (select id from map_draft where map_id = $1)`,
        [mapId],
      );
      await client.query(`delete from map_draft where map_id = $1`, [mapId]);
      await client.query(`delete from map_version where map_id = $1`, [mapId]);
      await client.query(`delete from map where id = $1`, [mapId]);

      await client.query("commit");
      reply.code(204);
      return null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
}
