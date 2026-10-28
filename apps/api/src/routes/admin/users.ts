import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createUser,
  deleteUser,
  DuplicateUsernameError,
  findUserById,
  InvalidUserTypeError,
  LastManagerGuardError,
  listUsers,
  listUserGroupIds,
  groupIdsForUser,
  setUserGroups,
  UnknownGroupError,
  setUserActive,
  updateUserPassword,
  updateUserType,
  type AppUser,
} from "@railway/database";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";
import { GUEST_VIEWER } from "../../lib/viewer.js";
import { typeWithinViewer } from "../../lib/permissionGuards.js";
import type { SiteAccess } from "../../lib/siteAccess.js";

export interface AdminUserRoutesDeps {
  pool: Pool;
  siteAccess: SiteAccess;
}

interface CreateUserBody {
  username?: unknown;
  password?: unknown;
  userTypeId?: unknown;
  groupIds?: unknown;
}

interface PatchUserBody {
  userTypeId?: unknown;
  isActive?: unknown;
  password?: unknown;
  groupIds?: unknown;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && /^\d+$/.test(id));
}

function userResponse(user: AppUser, groupIds: string[]) {
  return {
    id: user.id,
    username: user.username,
    // Milestone 99 (docs/adr/0022): the user's type decides what they can do.
    userTypeId: user.userTypeId,
    userTypeName: user.userTypeName,
    isActive: user.isActive,
    // Milestone 83: the groups this user is in (which restricted maps they can see).
    groupIds,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

/**
 * Milestone 29 (docs/IMPLEMENTATION_PLAN.md): admin-only user management, replacing the drafted
 * `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` env-var single-credential design (owner declined it —
 * wanted a real multi-user, multi-role system instead). Registered under a scope gated by
 * `admin.users` in `server.ts`. Milestone 99: a user can only give, or take away, a type whose
 * permissions they hold themselves (docs/adr/0022 §3). The very first admin account can't be
 * created through this API
 * (nothing is logged in yet) — see `apps/worker/src/commands/manageUsers.ts`'s `create` action.
 */
export async function registerAdminUserRoutes(
  app: FastifyInstance,
  deps: AdminUserRoutesDeps,
): Promise<void> {
  const { pool, siteAccess } = deps;

  /** 403 unless the requester holds every permission of `typeId` (null: fine). */
  async function outranked(
    request: { viewer: typeof GUEST_VIEWER | null },
    typeId: string | null,
  ): Promise<string | null> {
    if (typeId === null) return null;
    const ok = typeWithinViewer(await siteAccess.matrix(), typeId, request.viewer ?? GUEST_VIEWER);
    return ok
      ? null
      : "You can only give or change a user type whose permissions you hold yourself";
  }

  app.get("/api/v1/admin/users", async () => {
    const [users, groupIds] = await Promise.all([listUsers(pool), listUserGroupIds(pool)]);
    return { users: users.map((user) => userResponse(user, groupIds.get(user.id) ?? [])) };
  });

  app.post<{ Body: CreateUserBody }>("/api/v1/admin/users", async (request, reply) => {
    const { username, password, userTypeId, groupIds } = request.body ?? {};
    if (typeof username !== "string" || !username.trim()) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "username (non-empty string) is required");
    }
    if (typeof password !== "string" || password.length < 8) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "password (string, at least 8 characters) is required");
    }
    if (typeof userTypeId !== "string" || !/^\d+$/.test(userTypeId)) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "userTypeId (a user type id) is required");
    }
    if (groupIds !== undefined && !isIdList(groupIds)) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "groupIds must be an array of group ids");
    }
    const refused = await outranked(request, userTypeId);
    if (refused) {
      reply.code(403);
      return apiError("FORBIDDEN", refused);
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const user = await createUser(client, { username, password, userTypeId });
      if (groupIds) await setUserGroups(client, user.id, groupIds);
      await audit(
        client,
        request,
        "user.create",
        { type: "user", id: user.id },
        {
          username: user.username,
          userTypeId: user.userTypeId,
          userType: user.userTypeName,
          groupIds: groupIds ?? [],
        },
      );
      await client.query("commit");
      reply.code(201);
      return userResponse(user, await groupIdsForUser(pool, user.id));
    } catch (error) {
      await client.query("rollback");
      if (error instanceof DuplicateUsernameError) {
        reply.code(409);
        return apiError("DUPLICATE_USERNAME", error.message);
      }
      if (error instanceof InvalidUserTypeError) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", error.message);
      }
      if (error instanceof UnknownGroupError) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", error.message);
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string }; Body: PatchUserBody }>(
    "/api/v1/admin/users/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { userTypeId, isActive, password, groupIds } = request.body ?? {};

      if (
        userTypeId !== undefined &&
        (typeof userTypeId !== "string" || !/^\d+$/.test(userTypeId))
      ) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "userTypeId must be a user type id");
      }
      if (isActive !== undefined && typeof isActive !== "boolean") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "isActive must be a boolean");
      }
      if (password !== undefined && (typeof password !== "string" || password.length < 8)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "password (string, at least 8 characters) is required");
      }
      if (groupIds !== undefined && !isIdList(groupIds)) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "groupIds must be an array of group ids");
      }
      if (!/^\d+$/.test(id)) {
        reply.code(404);
        return apiError("USER_NOT_FOUND", `No user with id "${id}"`);
      }
      const target = await findUserById(pool, id);
      const refused =
        (await outranked(request, target?.userTypeId ?? null)) ??
        (await outranked(request, (userTypeId as string | undefined) ?? null));
      if (refused) {
        reply.code(403);
        return apiError("FORBIDDEN", refused);
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        let updated: AppUser | null = null;
        const changes: Record<string, unknown> = {};

        if (userTypeId !== undefined) {
          changes.userTypeIdBefore = target?.userTypeId ?? null;
          updated = await updateUserType(client, id, userTypeId as string);
          changes.userTypeId = userTypeId;
        }
        if (isActive !== undefined) {
          updated = await setUserActive(client, id, isActive as boolean);
          changes.isActive = isActive;
        }
        if (password !== undefined) {
          updated = await updateUserPassword(client, id, password as string);
          // Never the password itself — only that it changed.
          changes.password = "changed";
        }
        if (groupIds !== undefined) {
          updated = await findUserById(client, id);
          if (updated) {
            changes.groupIdsBefore = await groupIdsForUser(client, id);
            await setUserGroups(client, id, groupIds as string[]);
            changes.groupIds = groupIds;
          }
        }

        if (!updated) {
          await client.query("rollback");
          reply.code(404);
          return apiError("USER_NOT_FOUND", `No user with id "${id}"`);
        }
        await audit(
          client,
          request,
          "user.update",
          { type: "user", id },
          {
            username: updated.username,
            ...changes,
          },
        );
        await client.query("commit");
        siteAccess.invalidate();
        return userResponse(updated, await groupIdsForUser(pool, id));
      } catch (error) {
        await client.query("rollback");
        if (error instanceof LastManagerGuardError) {
          reply.code(409);
          return apiError("LAST_ADMIN", error.message);
        }
        if (error instanceof InvalidUserTypeError) {
          reply.code(400);
          return apiError("VALIDATION_ERROR", error.message);
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

  app.delete<{ Params: { id: string } }>("/api/v1/admin/users/:id", async (request, reply) => {
    try {
      const before = /^\d+$/.test(request.params.id)
        ? await findUserById(pool, request.params.id)
        : null;
      const refused = await outranked(request, before?.userTypeId ?? null);
      if (refused) {
        reply.code(403);
        return apiError("FORBIDDEN", refused);
      }
      const deleted = before ? await deleteUser(pool, request.params.id) : false;
      if (!deleted) {
        reply.code(404);
        return apiError("USER_NOT_FOUND", `No user with id "${request.params.id}"`);
      }
      await audit(
        pool,
        request,
        "user.delete",
        { type: "user", id: request.params.id },
        {
          username: before!.username,
        },
      );
      siteAccess.invalidate();
      reply.code(204);
    } catch (error) {
      if (error instanceof LastManagerGuardError) {
        reply.code(409);
        return apiError("LAST_ADMIN", error.message);
      }
      throw error;
    }
  });
}
