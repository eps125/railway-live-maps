import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  createUserType,
  deleteUserType,
  DuplicateUserTypeNameError,
  findUserType,
  isPermission,
  LastManagerGuardError,
  listUserTypes,
  PERMISSION_CATEGORIES,
  PERMISSIONS,
  SystemUserTypeError,
  updateUserTypeDefinition,
  UserTypeInUseError,
  isCodeGrantable,
  type Permission,
  type UserType,
} from "@railway/database";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";
import { GUEST_VIEWER, needs } from "../../lib/viewer.js";
import { permissionsWithinViewer } from "../../lib/permissionGuards.js";
import type { SiteAccess } from "../../lib/siteAccess.js";

export interface UserTypeRoutesDeps {
  pool: Pool;
  siteAccess: SiteAccess;
}

const NAME_MAX_LENGTH = 60;
const DESCRIPTION_MAX_LENGTH = 300;

function typeResponse(type: UserType) {
  return {
    id: type.id,
    systemKey: type.systemKey,
    name: type.name,
    description: type.description,
    sortOrder: type.sortOrder,
    grantsAll: type.grantsAll,
    permissions: type.permissions,
    userCount: type.userCount,
    codeCount: type.codeCount,
    // Whether an access code may give this type (docs/adr/0022 §4).
    codeGrantable: type.systemKey === null && type.permissions.every(isCodeGrantable),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function parseTypeFields(
  body: Record<string, unknown>,
  requireAll: boolean,
): Parsed<{
  name?: string;
  description?: string | null;
  sortOrder?: number;
  permissions?: Permission[];
}> {
  const out: {
    name?: string;
    description?: string | null;
    sortOrder?: number;
    permissions?: Permission[];
  } = {};
  const { name, description, sortOrder, permissions } = body;
  if (name !== undefined || requireAll) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > NAME_MAX_LENGTH) {
      return { ok: false, message: `name is required (at most ${NAME_MAX_LENGTH} characters)` };
    }
    out.name = name;
  }
  if (description !== undefined) {
    if (
      description !== null &&
      (typeof description !== "string" || description.length > DESCRIPTION_MAX_LENGTH)
    ) {
      return {
        ok: false,
        message: `description must be null or at most ${DESCRIPTION_MAX_LENGTH} characters`,
      };
    }
    out.description = description as string | null;
  }
  if (sortOrder !== undefined) {
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder)) {
      return { ok: false, message: "sortOrder must be a whole number" };
    }
    out.sortOrder = sortOrder;
  }
  if (permissions !== undefined || requireAll) {
    if (!Array.isArray(permissions) || !permissions.every(isPermission)) {
      return { ok: false, message: "permissions must be an array of known permissions" };
    }
    out.permissions = permissions;
  }
  return { ok: true, value: out };
}

/**
 * Milestone 99 (docs/adr/0022): Admin › User types — the permission matrix. Listing types is open
 * to anyone who assigns them (users, access codes); changing them needs `admin.user_types`, and a
 * change may only add or remove permissions the requester holds themselves. Every change is
 * audited and clears the API's cached matrix, so it applies on the next request.
 */
export async function registerUserTypeRoutes(
  app: FastifyInstance,
  deps: UserTypeRoutesDeps,
): Promise<void> {
  const { pool, siteAccess } = deps;

  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  function changeError(
    error: unknown,
  ): { status: number; body: ReturnType<typeof apiError> } | null {
    if (error instanceof DuplicateUserTypeNameError) {
      return { status: 409, body: apiError("DUPLICATE_NAME", error.message) };
    }
    if (error instanceof LastManagerGuardError) {
      return { status: 409, body: apiError("LAST_ADMIN", error.message) };
    }
    if (error instanceof SystemUserTypeError) {
      return { status: 409, body: apiError("SYSTEM_USER_TYPE", error.message) };
    }
    if (error instanceof UserTypeInUseError) {
      return {
        status: 409,
        body: apiError("USER_TYPE_IN_USE", error.message, {
          userCount: error.userCount,
          codeCount: error.codeCount,
        }),
      };
    }
    return null;
  }

  app.get(
    "/api/v1/admin/user-types",
    { preHandler: needs(["admin.user_types", "admin.users", "admin.access_codes"]) },
    async () => ({
      types: (await listUserTypes(pool)).map(typeResponse),
      // The registry, so the matrix page lists every permission in order, with its help text.
      permissions: PERMISSIONS.map((p) => ({ ...p, codeGrantable: isCodeGrantable(p.key) })),
      categories: PERMISSION_CATEGORIES,
    }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    "/api/v1/admin/user-types",
    { preHandler: needs("admin.user_types") },
    async (request, reply) => {
      const parsed = parseTypeFields(request.body ?? {}, true);
      if (!parsed.ok) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", parsed.message);
      }
      const fields = parsed.value;
      if (!permissionsWithinViewer(fields.permissions!, request.viewer ?? GUEST_VIEWER)) {
        reply.code(403);
        return apiError("FORBIDDEN", "A user type can only hold permissions you hold yourself");
      }
      try {
        const created = await inTransaction(async (client) => {
          const type = await createUserType(client, {
            name: fields.name!,
            description: fields.description,
            sortOrder: fields.sortOrder,
            permissions: fields.permissions!,
          });
          await audit(
            client,
            request,
            "user_type.create",
            { type: "user_type", id: type.id },
            { name: type.name, permissions: type.permissions },
          );
          return type;
        });
        siteAccess.invalidate();
        reply.code(201);
        return typeResponse(created);
      } catch (error) {
        const known = changeError(error);
        if (known) {
          reply.code(known.status);
          return known.body;
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/user-types/:id",
    { preHandler: needs("admin.user_types") },
    async (request, reply) => {
      const parsed = parseTypeFields(request.body ?? {}, false);
      if (!parsed.ok) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", parsed.message);
      }
      const before = await findUserType(pool, request.params.id);
      if (!before) {
        reply.code(404);
        return apiError("USER_TYPE_NOT_FOUND", `No user type with id "${request.params.id}"`);
      }
      const fields = parsed.value;
      if (fields.permissions !== undefined) {
        // Only permissions the requester holds may be added or taken away.
        const after = new Set(fields.permissions);
        const changed = [
          ...fields.permissions.filter((p) => !before.permissions.includes(p)),
          ...before.permissions.filter((p) => !after.has(p)),
        ];
        if (!permissionsWithinViewer(changed, request.viewer ?? GUEST_VIEWER)) {
          reply.code(403);
          return apiError("FORBIDDEN", "You can only change permissions you hold yourself");
        }
      }
      try {
        const updated = await inTransaction(async (client) => {
          const type = await updateUserTypeDefinition(client, before.id, fields);
          await audit(
            client,
            request,
            "user_type.update",
            { type: "user_type", id: before.id },
            {
              name: type!.name,
              before: {
                name: before.name,
                description: before.description,
                permissions: before.permissions,
              },
              after: {
                name: type!.name,
                description: type!.description,
                permissions: type!.permissions,
              },
            },
          );
          return type!;
        });
        siteAccess.invalidate();
        return typeResponse(updated);
      } catch (error) {
        const known = changeError(error);
        if (known) {
          reply.code(known.status);
          return known.body;
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/user-types/:id",
    { preHandler: needs("admin.user_types") },
    async (request, reply) => {
      const before = await findUserType(pool, request.params.id);
      if (!before) {
        reply.code(404);
        return apiError("USER_TYPE_NOT_FOUND", `No user type with id "${request.params.id}"`);
      }
      try {
        await inTransaction(async (client) => {
          await deleteUserType(client, before.id);
          await audit(
            client,
            request,
            "user_type.delete",
            { type: "user_type", id: before.id },
            { name: before.name, permissions: before.permissions },
          );
        });
        siteAccess.invalidate();
        reply.code(204);
        return null;
      } catch (error) {
        const known = changeError(error);
        if (known) {
          reply.code(known.status);
          return known.body;
        }
        throw error;
      }
    },
  );
}
