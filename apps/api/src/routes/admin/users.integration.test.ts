import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, createUser, setUserActive } from "@railway/database";
import { registerAdminUserRoutes } from "./users.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function freshUsername(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** See the identical helper's doc comment in `packages/database/src/users.integration.test.ts` —
 * the "last active admin" guard is a global-state check, and this suite's tests all share one
 * real database with no per-test transaction rollback, so a test needs to neutralize any admin
 * accounts it didn't create itself before asserting "this is *the* last one." */
async function withOnlyTheseAdminsActive<T>(
  db: Pool,
  keepActiveIds: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const { rows: others } = await db.query<{ id: string }>(
    `select id from app_user where role = 'admin' and is_active = true and id != all($1::bigint[])`,
    [keepActiveIds],
  );
  for (const row of others) await setUserActive(db, row.id, false);
  try {
    return await fn();
  } finally {
    for (const row of others) await setUserActive(db, row.id, true);
  }
}

async function buildApp() {
  const app = Fastify();
  await registerAdminUserRoutes(app, { pool });
  await app.ready();
  return app;
}

/**
 * Milestone 29: exercises the admin user-management HTTP surface directly (role gating itself —
 * "only an admin session reaches these handlers at all" — is covered end to end in
 * `apps/api/src/server.integration.test.ts`; this file is about the CRUD behavior once inside).
 */
describe("admin user routes (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("creates a user via POST, then lists it via GET", async () => {
    const app = await buildApp();
    const username = freshUsername("created-via-api");

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: { username, password: "hunter2hunter2", role: "editor" },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.role).toBe("editor");
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
    await createUser(pool, { username, password: "hunter2hunter2", role: "editor" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      payload: { username, password: "hunter2hunter2", role: "editor" },
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
      payload: { username: freshUsername("short-pw"), password: "short", role: "editor" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH updates role and isActive independently", async () => {
    const app = await buildApp();
    const other = await createUser(pool, {
      username: freshUsername("keeps-admin-alive"),
      password: "hunter2hunter2",
      role: "admin",
    });
    void other;
    const user = await createUser(pool, {
      username: freshUsername("patchable"),
      password: "hunter2hunter2",
      role: "editor",
    });

    const roleResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${user.id}`,
      payload: { role: "admin" },
    });
    expect(roleResponse.statusCode).toBe(200);
    expect(roleResponse.json().role).toBe("admin");

    const activeResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${user.id}`,
      payload: { isActive: false },
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json().isActive).toBe(false);
    // The role change from the previous request must have stuck.
    expect(activeResponse.json().role).toBe("admin");

    // Both `other` and `user` end up as admin accounts left in the shared test database — safe:
    // any later test asserting a specific "last admin" state uses `withOnlyTheseAdminsActive`
    // above, which neutralizes stray admins like these for the duration of its own assertions.
    await app.close();
  });

  it("PATCH returns 409 (not a 500) when it would remove the last active admin", async () => {
    const app = await buildApp();
    const admin = await createUser(pool, {
      username: freshUsername("sole-admin"),
      password: "hunter2hunter2",
      role: "admin",
    });

    await withOnlyTheseAdminsActive(pool, [admin.id], async () => {
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
      role: "editor",
    });

    const first = await app.inject({ method: "DELETE", url: `/api/v1/admin/users/${user.id}` });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: "DELETE", url: `/api/v1/admin/users/${user.id}` });
    expect(second.statusCode).toBe(404);

    await app.close();
  });
});
