import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { assertGroupsExist, findRegionById, UnknownGroupError } from "@railway/database";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";
import { draftsUsingModule, mapsUsingModule } from "../../editor/modules.js";

export interface ManageMapRouteDeps {
  pool: Pool;
}

interface RenameMapBody {
  name?: unknown;
  slug?: unknown;
  /** Milestone 83 (docs/adr/0018): map settings. `null` clears description/region. */
  description?: unknown;
  regionId?: unknown;
  visibility?: unknown;
  groupIds?: unknown;
}

const DESCRIPTION_MAX_LENGTH = 280;

interface MapSettingsRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: string;
  region_id: string | null;
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
 * (`server.ts`'s `adminMapScope`). Milestone 83 adds the map's settings — description, region,
 * visibility and the groups a restricted map is shared with — and an audit entry per change.
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
      const body = request.body ?? {};
      const { name, slug: newSlugRaw, description, regionId, visibility, groupIds } = body;

      if (
        name === undefined &&
        newSlugRaw === undefined &&
        description === undefined &&
        regionId === undefined &&
        visibility === undefined &&
        groupIds === undefined
      ) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "at least one setting is required");
      }
      if (
        description !== undefined &&
        description !== null &&
        (typeof description !== "string" || description.length > DESCRIPTION_MAX_LENGTH)
      ) {
        reply.code(400);
        return apiError(
          "VALIDATION_ERROR",
          `description must be null or a string of at most ${DESCRIPTION_MAX_LENGTH} characters`,
        );
      }
      if (regionId !== undefined && regionId !== null) {
        if (typeof regionId !== "string" || !(await findRegionById(pool, regionId))) {
          reply.code(400);
          return apiError("VALIDATION_ERROR", "regionId must be null or an existing region's id");
        }
      }
      if (visibility !== undefined && visibility !== "public" && visibility !== "restricted") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", 'visibility must be "public" or "restricted"');
      }
      if (
        groupIds !== undefined &&
        (!Array.isArray(groupIds) ||
          groupIds.some((id) => typeof id !== "string" || !/^\d+$/.test(id)))
      ) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "groupIds must be an array of group ids");
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

        const beforeResult = await client.query<MapSettingsRow>(
          `select id::text, slug, name, description, visibility, region_id::text
             from map where slug = $1 for update`,
          [currentSlug],
        );
        const before = beforeResult.rows[0];
        if (!before) {
          await client.query("rollback");
          reply.code(404);
          return apiError("MAP_NOT_FOUND", `No map with slug "${currentSlug}" exists`);
        }
        const groupIdsBefore = (
          await client.query<{ group_id: string }>(
            `select group_id::text from map_visibility_group where map_id = $1 order by group_id`,
            [before.id],
          )
        ).rows.map((row) => row.group_id);

        const updated = await client.query<MapSettingsRow>(
          `update map
             set name = coalesce($1, name),
                 slug = coalesce($2, slug),
                 description = case when $4::boolean then $5 else description end,
                 region_id = case when $6::boolean then $7::bigint else region_id end,
                 visibility = coalesce($8, visibility)
           where id = $3
           returning id::text, slug, name, description, visibility, region_id::text`,
          [
            name ?? null,
            newSlug ?? null,
            before.id,
            description !== undefined,
            typeof description === "string" && description.trim() ? description.trim() : null,
            regionId !== undefined,
            regionId ?? null,
            visibility ?? null,
          ],
        );
        const mapRow = updated.rows[0]!;

        let groupIdsAfter = groupIdsBefore;
        if (groupIds !== undefined) {
          const unique = [...new Set(groupIds as string[])];
          await assertGroupsExist(client, unique);
          await client.query(`delete from map_visibility_group where map_id = $1`, [before.id]);
          await client.query(
            `insert into map_visibility_group (map_id, group_id)
             select $1, unnest($2::bigint[])`,
            [before.id, unique],
          );
          groupIdsAfter = unique.sort((a, b) => Number(a) - Number(b));
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

        await audit(
          client,
          request,
          "map.settings",
          { type: "map", id: before.id },
          {
            slug: mapRow.slug,
            before: { ...settingsSummary(before), groupIds: groupIdsBefore },
            after: { ...settingsSummary(mapRow), groupIds: groupIdsAfter },
          },
        );

        await client.query("commit");
        return {
          mapId: mapRow.id,
          slug: mapRow.slug,
          name: mapRow.name,
          description: mapRow.description,
          regionId: mapRow.region_id,
          visibility: mapRow.visibility,
          groupIds: groupIdsAfter,
        };
      } catch (error) {
        await client.query("rollback");
        if (isUniqueViolation(error)) {
          reply.code(409);
          return apiError("DUPLICATE_SLUG", `A map with slug "${newSlug}" already exists`);
        }
        if (error instanceof UnknownGroupError) {
          reply.code(400);
          return apiError("VALIDATION_ERROR", error.message);
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

      const mapRow = await client.query<{ id: string; name: string; kind: string }>(
        `select id, name, kind from map where slug = $1`,
        [slug],
      );
      const mapId = mapRow.rows[0]?.id;
      if (!mapId) {
        await client.query("rollback");
        reply.code(404);
        return apiError("MAP_NOT_FOUND", `No map with slug "${slug}" exists`);
      }
      // Milestone 85: a module still part of a map can't be deleted out from under it.
      if (mapRow.rows[0]!.kind === "module") {
        const users = [
          ...new Set([
            ...(await mapsUsingModule(client, slug)),
            ...(await draftsUsingModule(client, slug)),
          ]),
        ];
        if (users.length > 0) {
          await client.query("rollback");
          reply.code(409);
          return apiError(
            "MODULE_IN_USE",
            `This module is used by ${users.join(", ")} — remove it from those maps first`,
            { maps: users },
          );
        }
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
      await client.query(`delete from map_module_version where map_id = $1`, [mapId]);
      // Milestone 83: visibility groups go with the map (FK cascade); the audit entry stays.
      await client.query(`delete from map where id = $1`, [mapId]);
      await audit(
        client,
        request,
        "map.delete",
        { type: "map", id: mapId },
        {
          slug,
          name: mapRow.rows[0]!.name,
        },
      );

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

function settingsSummary(row: MapSettingsRow) {
  return {
    name: row.name,
    slug: row.slug,
    description: row.description,
    regionId: row.region_id,
    visibility: row.visibility,
  };
}
