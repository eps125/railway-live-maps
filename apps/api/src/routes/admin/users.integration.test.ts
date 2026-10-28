import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, createUser, findUserTypeByName } from "@railway/database";
import { registerAdminUserRoutes } from "./users.js";
import { createSiteAccess } from "../../lib/siteAccess.js";
import { viewerWith } from "../../lib/testViewers.js";
import type { Viewer } from "../../lib/viewer.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const siteAccess = createSiteAccess(pool, { timers: false });

let adminTypeId = "";
let editorTypeId = "";
let enhancedEditorTypeId = "";

function freshUsername(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** See the identical helper's doc comment in `packages/database/src/users.integration.test.ts` —
 * the "last manager" guard is a global-state check, and this suite's tests all share one real
 * database with no per-test transaction rollback, so a test needs to neutralize every other
 * active user before asserting "this is *the* last one." */
async function withOnlyTheseUsersActive<T>(
  db: Pool,
  keepActiveIds: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const { rows: others } = await db.query<{ id: string }>(
    `select id::text from app_user where is_active = true and id != all($1::bigint[])`,
    [keepActiveIds],
  );
  const ids = others.map((row) => row.id);
  await db.query(`update app_user set is_active = false where id = any($1::bigint[])`, [ids]);
  try {
    return await fn();
  } finally {
    await db.query(`update app_user set is_active = true where id = any($1::bigint[])`, [ids]);
  }
}

/** The routes run as `viewer` (an Admin by default) — the scope's permission hook is covered in
 * `server.integration.test.ts`. */
async function buildApp(viewer: Viewer = viewerWith()) {
  const app = Fastify();
  app.decorateRequest("viewer", null);
  app.decorateRequest("authSession", null);
  app.addHook("onRequest", async (request) => {
    request.viewer = viewer;
  });
  await registerAdminUserRoutes(app, { pool, siteAccess });
  await app.ready();
  return app;
}

/**
 * Milestone 29: exercises the admin user-management HTTP surface directly (role gating itself —
 * "only an admin session reaches these handlers at all" — is covered end to end in
 * `apps/api/src/server.integration.test.ts`; this file is about the CRUD behavior once inside).
 */
describe("admin user routes (integration)", () => {
  beforeAll(async () => {
    adminTypeId = (await findUserTypeByName(pool, "Admin"))!.id;
    editorTypeId = (await findUserTypeByName(pool, "Editor"))!.id;
    enhancedEditorTypeId = (await findUserTypeByName(pool, "Enhanced Editor"))!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a user via POST, then lists it via GET", async () => {
    const app = await buildApp();
    const username = freshUsername("created-via-api");

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: { username, password: "hunter2hunter2", userTypeId: editorTypeId },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.userTypeId).toBe(editorTypeId);
    expect(created.userTypeName).toBe("Editor");
    expect(created.username).toBe(username.toLowerCase());
    expect(created).not.toHaveProperty("passwordHash");
    expect(created).not.toHaveProperty("password");

    const listResponse = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().users.some((u: { id: string }) => u.id === created.id)).toBe(true);

    await app.close();
  });

  it("rejects a duplicate username with 409", async () => {
    const app = await buildApp();
    const username = freshUsername("dup");
    await createUser(pool, { username, password: "hunter2hunter2", userTypeId: editorTypeId });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: { username, password: "hunter2hunter2", userTypeId: editorTypeId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DUPLICATE_USERNAME");

    await app.close();
  });

  it("rejects a short password with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: { username: freshUsername("short-pw"), password: "short", userTypeId: editorTypeId },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH updates the user type and isActive independently", async () => {
    const app = await buildApp();
    const other = await createUser(pool, {
      username: freshUsername("keeps-admin-alive"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });
    void other;
    const user = await createUser(pool, {
      username: freshUsername("patchable"),
      password: "hunter2hunter2",
      userTypeId: editorTypeId,
    });

    const roleResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${user.id}`,
      payload: { userTypeId: adminTypeId },
    });
    expect(roleResponse.statusCode).toBe(200);
    expect(roleResponse.json().userTypeName).toBe("Admin");

    const activeResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${user.id}`,
      payload: { isActive: false },
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json().isActive).toBe(false);
    // The type change from the previous request must have stuck.
    expect(activeResponse.json().userTypeName).toBe("Admin");

    // Both `other` and `user` end up as admin accounts left in the shared test database — safe:
    // any later test asserting a specific "last manager" state uses `withOnlyTheseUsersActive`
    // above, which neutralizes stray accounts like these for the duration of its own assertions.
    await app.close();
  });

  it("PATCH returns 409 (not a 500) when it would remove the last active admin", async () => {
    const app = await buildApp();
    const admin = await createUser(pool, {
      username: freshUsername("sole-admin"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });

    await withOnlyTheseUsersActive(pool, [admin.id], async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/users/${admin.id}`,
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("LAST_ADMIN");
    });

    await app.close();
  });

  it("refuses to give, change or remove a type holding permissions the requester lacks", async () => {
    // An Enhanced Editor with admin.users added, but none of the other admin permissions.
    const enhancedEditor = (await findUserTypeByName(pool, "Enhanced Editor"))!;
    const app = await buildApp(viewerWith([...enhancedEditor.permissions, "admin.users"]));

    const giveAdmin = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: {
        username: freshUsername("escalate"),
        password: "hunter2hunter2",
        userTypeId: adminTypeId,
      },
    });
    expect(giveAdmin.statusCode).toBe(403);

    const giveEditor = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: {
        username: freshUsername("allowed"),
        password: "hunter2hunter2",
        userTypeId: enhancedEditorTypeId,
      },
    });
    expect(giveEditor.statusCode).toBe(201);

    const admin = await createUser(pool, {
      username: freshUsername("untouchable"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${admin.id}`,
      payload: { userTypeId: editorTypeId },
    });
    expect(demote.statusCode).toBe(403);
    const remove = await app.inject({ method: "DELETE", url: `/api/v1/admin/users/${admin.id}` });
    expect(remove.statusCode).toBe(403);

    await app.close();
  });

  it("PATCH 404s for a nonexistent user id", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/users/999999999",
      payload: { isActive: false },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("DELETE removes a user, and a second delete 404s", async () => {
    const app = await buildApp();
    const user = await createUser(pool, {
      username: freshUsername("deletable"),
      password: "hunter2hunter2",
      userTypeId: editorTypeId,
    });

    const first = await app.inject({ method: "DELETE", url: `/api/v1/admin/users/${user.id}` });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: "DELETE", url: `/api/v1/admin/users/${user.id}` });
    expect(second.statusCode).toBe(404);

    await app.close();
  });
});
