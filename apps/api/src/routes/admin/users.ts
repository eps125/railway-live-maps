import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createUser,
  deleteUser,
  DuplicateUsernameError,
  isUserRole,
  LastAdminGuardError,
  listUsers,
  setUserActive,
  updateUserPassword,
  updateUserRole,
  type AppUser,
} from "@railway/database";
import { apiError } from "../../lib/queryRange.js";

export interface AdminUserRoutesDeps {
  pool: Pool;
}

interface CreateUserBody {
  username?: unknown;
  password?: unknown;
  role?: unknown;
}

interface PatchUserBody {
  role?: unknown;
  isActive?: unknown;
  password?: unknown;
}

function userResponse(user: AppUser) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
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
    const users = await listUsers(pool);
    return { users: users.map(userResponse) };
  });

  app.post<{ Body: CreateUserBody }>("/api/v1/admin/users", async (request, reply) => {
    const { username, password, role } = request.body ?? {};
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

    try {
      const user = await createUser(pool, { username, password, role });
      reply.code(201);
      return userResponse(user);
    } catch (error) {
      if (error instanceof DuplicateUsernameError) {
        reply.code(409);
        return apiError("DUPLICATE_USERNAME", error.message);
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string }; Body: PatchUserBody }>(
    "/api/v1/admin/users/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { role, isActive, password } = request.body ?? {};

      try {
        let updated: AppUser | null = null;

        if (role !== undefined) {
          if (typeof role !== "string" || !isUserRole(role)) {
            reply.code(400);
            return apiError("VALIDATION_ERROR", 'role must be "admin" or "editor"');
          }
          updated = await updateUserRole(pool, id, role);
        }
        if (isActive !== undefined) {
          if (typeof isActive !== "boolean") {
            reply.code(400);
            return apiError("VALIDATION_ERROR", "isActive must be a boolean");
          }
          updated = await setUserActive(pool, id, isActive);
        }
        if (password !== undefined) {
          if (typeof password !== "string" || password.length < 8) {
            reply.code(400);
            return apiError(
              "VALIDATION_ERROR",
              "password (string, at least 8 characters) is required",
            );
          }
          updated = await updateUserPassword(pool, id, password);
        }

        if (!updated) {
          reply.code(404);
          return apiError("USER_NOT_FOUND", `No user with id "${id}"`);
        }
        return userResponse(updated);
      } catch (error) {
        if (error instanceof LastAdminGuardError) {
          reply.code(409);
          return apiError("LAST_ADMIN", error.message);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/admin/users/:id", async (request, reply) => {
    try {
      const deleted = await deleteUser(pool, request.params.id);
      if (!deleted) {
        reply.code(404);
        return apiError("USER_NOT_FOUND", `No user with id "${request.params.id}"`);
      }
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
