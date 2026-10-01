import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createGroup,
  createRegion,
  deleteGroup,
  deleteRegion,
  DuplicateGroupNameError,
  DuplicateRegionNameError,
  findGroupById,
  findRegionById,
  getSiteSettings,
  isSiteSettingKey,
  isValidSiteSettingValue,
  listAuditEntries,
  listGroups,
  listRegions,
  setSiteSetting,
  updateGroup,
  updateRegion,
  type MapRegion,
  type SiteSettings,
  type UserGroup,
} from "@railway/database";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";

export interface SiteAdminRoutesDeps {
  pool: Pool;
  /** Called after settings change, so cached copies (the site access mode) are dropped. */
  onSettingsChanged?: () => void;
}

const NAME_MAX_LENGTH = 80;
const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;

function groupResponse(group: UserGroup) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    memberCount: group.memberCount,
    createdAt: group.createdAt.toISOString(),
  };
}

function regionResponse(region: MapRegion) {
  return {
    id: region.id,
    name: region.name,
    sortOrder: region.sortOrder,
    mapCount: region.mapCount,
  };
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= NAME_MAX_LENGTH
  );
}

const ID_PATTERN = /^\d+$/;

/**
 * Milestone 83 (docs/adr/0018): admin-only site configuration — user groups, map regions, site
 * settings and the audit log. Registered in an admin-gated scope by `server.ts`. Every change
 * writes an audit entry in the same transaction as the change where there is one.
 */
export async function registerSiteAdminRoutes(
  app: FastifyInstance,
  deps: SiteAdminRoutesDeps,
): Promise<void> {
  const { pool, onSettingsChanged } = deps;

  // ---- Groups -------------------------------------------------------------------------------

  app.get("/api/v1/admin/groups", async () => ({
    groups: (await listGroups(pool)).map(groupResponse),
  }));

  app.post<{ Body: { name?: unknown; description?: unknown } }>(
    "/api/v1/admin/groups",
    async (request, reply) => {
      const { name, description } = request.body ?? {};
      if (!validName(name)) {
        reply.code(400);
        return apiError(
          "VALIDATION_ERROR",
          `name is required (at most ${NAME_MAX_LENGTH} characters)`,
        );
      }
      if (description !== undefined && description !== null && typeof description !== "string") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "description must be a string");
      }
      try {
        const group = await createGroup(pool, { name, description: description ?? null });
        await audit(
          pool,
          request,
          "group.create",
          { type: "group", id: group.id },
          { name: group.name },
        );
        reply.code(201);
        return groupResponse(group);
      } catch (error) {
        if (error instanceof DuplicateGroupNameError) {
          reply.code(409);
          return apiError("DUPLICATE_NAME", error.message);
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown; description?: unknown } }>(
    "/api/v1/admin/groups/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { name, description } = request.body ?? {};
      if (name !== undefined && !validName(name)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", `name must be 1-${NAME_MAX_LENGTH} characters`);
      }
      if (description !== undefined && description !== null && typeof description !== "string") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "description must be a string or null");
      }
      if (!ID_PATTERN.test(id)) {
        reply.code(404);
        return apiError("GROUP_NOT_FOUND", `No group with id "${id}"`);
      }
      const before = await findGroupById(pool, id);
      try {
        const group = await updateGroup(pool, id, {
          name: name as string | undefined,
          description: description as string | null | undefined,
        });
        if (!group) {
          reply.code(404);
          return apiError("GROUP_NOT_FOUND", `No group with id "${id}"`);
        }
        await audit(
          pool,
          request,
          "group.update",
          { type: "group", id },
          {
            before: before ? { name: before.name, description: before.description } : null,
            after: { name: group.name, description: group.description },
          },
        );
        return groupResponse(group);
      } catch (error) {
        if (error instanceof DuplicateGroupNameError) {
          reply.code(409);
          return apiError("DUPLICATE_NAME", error.message);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/admin/groups/:id", async (request, reply) => {
    const { id } = request.params;
    const before = ID_PATTERN.test(id) ? await findGroupById(pool, id) : null;
    if (!before || !(await deleteGroup(pool, id))) {
      reply.code(404);
      return apiError("GROUP_NOT_FOUND", `No group with id "${id}"`);
    }
    await audit(pool, request, "group.delete", { type: "group", id }, { name: before.name });
    reply.code(204);
    return null;
  });

  // ---- Regions ------------------------------------------------------------------------------

  app.get("/api/v1/admin/regions", async () => ({
    regions: (await listRegions(pool)).map(regionResponse),
  }));

  app.post<{ Body: { name?: unknown } }>("/api/v1/admin/regions", async (request, reply) => {
    const { name } = request.body ?? {};
    if (!validName(name)) {
      reply.code(400);
      return apiError(
        "VALIDATION_ERROR",
        `name is required (at most ${NAME_MAX_LENGTH} characters)`,
      );
    }
    try {
      const region = await createRegion(pool, { name });
      await audit(
        pool,
        request,
        "region.create",
        { type: "region", id: region.id },
        { name: region.name },
      );
      reply.code(201);
      return regionResponse(region);
    } catch (error) {
      if (error instanceof DuplicateRegionNameError) {
        reply.code(409);
        return apiError("DUPLICATE_NAME", error.message);
      }
      throw error;
    }
  });

  // Reorder: the full list of region ids, first to last.
  app.put<{ Body: { ids?: unknown } }>("/api/v1/admin/regions/order", async (request, reply) => {
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !ID_PATTERN.test(id))) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "ids must be an array of region ids");
    }
    const current = await listRegions(pool);
    const known = new Set(current.map((region) => region.id));
    if (
      ids.length !== known.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !known.has(id))
    ) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "ids must list every region exactly once");
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update map_region r set sort_order = o.position * 10
           from unnest($1::bigint[]) with ordinality as o(id, position)
          where r.id = o.id`,
        [ids],
      );
      await audit(client, request, "region.reorder", null, { ids });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { regions: (await listRegions(pool)).map(regionResponse) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/api/v1/admin/regions/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { name } = request.body ?? {};
      if (!validName(name)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", `name must be 1-${NAME_MAX_LENGTH} characters`);
      }
      const before = await findRegionById(pool, id);
      try {
        const region = await updateRegion(pool, id, { name });
        if (!region || !before) {
          reply.code(404);
          return apiError("REGION_NOT_FOUND", `No region with id "${id}"`);
        }
        await audit(
          pool,
          request,
          "region.update",
          { type: "region", id },
          {
            before: { name: before.name },
            after: { name: region.name },
          },
        );
        return regionResponse(region);
      } catch (error) {
        if (error instanceof DuplicateRegionNameError) {
          reply.code(409);
          return apiError("DUPLICATE_NAME", error.message);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/admin/regions/:id", async (request, reply) => {
    const { id } = request.params;
    const before = await findRegionById(pool, id);
    if (!before || !(await deleteRegion(pool, id))) {
      reply.code(404);
      return apiError("REGION_NOT_FOUND", `No region with id "${id}"`);
    }
    await audit(
      pool,
      request,
      "region.delete",
      { type: "region", id },
      {
        name: before.name,
        mapCount: before.mapCount,
      },
    );
    reply.code(204);
    return null;
  });

  // ---- Settings -----------------------------------------------------------------------------

  app.get("/api/v1/admin/settings", async () => ({ settings: await getSiteSettings(pool) }));

  app.patch<{ Body: Record<string, unknown> }>("/api/v1/admin/settings", async (request, reply) => {
    const body = request.body ?? {};
    const entries = Object.entries(body);
    if (entries.length === 0) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "at least one setting is required");
    }
    for (const [key, value] of entries) {
      if (!isSiteSettingKey(key)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", `unknown setting "${key}"`);
      }
      if (!isValidSiteSettingValue(key, value)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", `setting "${key}" has the wrong type`);
      }
    }
    const before = await getSiteSettings(pool);
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const [key, value] of entries) {
        const settingKey = key as keyof SiteSettings;
        await setSiteSetting(
          client,
          settingKey,
          value as SiteSettings[typeof settingKey],
          request.authSession?.username ?? null,
        );
        await audit(
          client,
          request,
          "setting.update",
          { type: "setting", id: key },
          {
            before: before[settingKey],
            after: value,
          },
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    onSettingsChanged?.();
    return { settings: await getSiteSettings(pool) };
  });

  // ---- Audit log ----------------------------------------------------------------------------

  app.get<{ Querystring: { action?: string; user?: string; before?: string; limit?: string } }>(
    "/api/v1/admin/audit-log",
    async (request, reply) => {
      const { action, user, before } = request.query;
      if (before !== undefined && !ID_PATTERN.test(before)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "before must be an entry id");
      }
      const requested = Number(request.query.limit ?? AUDIT_DEFAULT_LIMIT);
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), AUDIT_MAX_LIMIT)
          : AUDIT_DEFAULT_LIMIT;
      const page = await listAuditEntries(pool, { action, actorUsername: user, before, limit });
      return {
        entries: page.entries.map((entry) => ({
          ...entry,
          occurredAt: entry.occurredAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
