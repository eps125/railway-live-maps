import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createUser,
  deleteUser,
  DuplicateUsernameError,
  findUserById,
  isUserRole,
  LastAdminGuardError,
  listUsers,
  listUserGroupIds,
  groupIdsForUser,
  setUserGroups,
  UnknownGroupError,
  setUserActive,
  updateUserPassword,
  updateUserRole,
  type AppUser,
  type UserRole,
} from "@railway/database";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";

export interface AdminUserRoutesDeps {
  pool: Pool;
}

interface CreateUserBody {
  username?: unknown;
  password?: unknown;
  role?: unknown;
  groupIds?: unknown;
}

interface PatchUserBody {
  role?: unknown;
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
    role: user.role,
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
 * `requireRole("admin", ...)` in `server.ts` — every route here assumes `request.authSession` is
 * already a valid admin session. The very first admin account can't be created through this API
 * (nothing is logged in yet) — see `apps/worker/src/commands/manageUsers.ts`'s `create` action.
 */
export async function registerAdminUserRoutes(
  app: FastifyInstance,
  deps: AdminUserRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/admin/users", async () => {
    const [users, groupIds] = await Promise.all([listUsers(pool), listUserGroupIds(pool)]);
    return { users: users.map((user) => userResponse(user, groupIds.get(user.id) ?? [])) };
  });

  app.post<{ Body: CreateUserBody }>("/api/v1/admin/users", async (request, reply) => {
    const { username, password, role, groupIds } = request.body ?? {};
    if (typeof username !== "string" || !username.trim()) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "username (non-empty string) is required");
    }
    if (typeof password !== "string" || password.length < 8) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "password (string, at least 8 characters) is required");
    }
    if (typeof role !== "string" || !isUserRole(role)) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", 'role must be "admin" or "editor"');
    }
    if (groupIds !== undefined && !isIdList(groupIds)) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "groupIds must be an array of group ids");
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const user = await createUser(client, { username, password, role });
      if (groupIds) await setUserGroups(client, user.id, groupIds);
      await audit(
        client,
        request,
        "user.create",
        { type: "user", id: user.id },
        {
          username: user.username,
          role: user.role,
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
      const { role, isActive, password, groupIds } = request.body ?? {};

      if (role !== undefined && (typeof role !== "string" || !isUserRole(role))) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", 'role must be "admin" or "editor"');
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

      const client = await pool.connect();
      try {
        await client.query("begin");
        let updated: AppUser | null = null;
        const changes: Record<string, unknown> = {};

        if (role !== undefined) {
          updated = await updateUserRole(client, id, role as UserRole);
          changes.role = role;
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
        return userResponse(updated, await groupIdsForUser(pool, id));
      } catch (error) {
        await client.query("rollback");
        if (error instanceof LastAdminGuardError) {
          reply.code(409);
          return apiError("LAST_ADMIN", error.message);
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
      reply.code(204);
    } catch (error) {
      if (error instanceof LastAdminGuardError) {
        reply.code(409);
        return apiError("LAST_ADMIN", error.message);
      }
      throw error;
    }
  });
}
