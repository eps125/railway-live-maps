import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "./pool.js";
import {
  countOtherActiveAdmins,
  createUser,
  deleteUser,
  DuplicateUsernameError,
  findUserByUsername,
  LastAdminGuardError,
  setUserActive,
  updateUserRole,
} from "./users.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function freshUsername(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * The "last active admin" guard is inherently a global-state check, and this integration suite
 * shares one real database across every test file in a `pnpm run test:integration` run (no
 * per-test transaction rollback) — so a test asserting "this is *the* last admin" would be flaky
 * against any other admin account left behind by another test (this file's own tests included).
 * This temporarily deactivates every admin account not in `keepActiveIds` for the duration of
 * `fn`, then restores them, so each guard assertion runs against a truly known admin population
 * regardless of what else exists in the database.
 */
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

describe("users (integration, migration 0029_app_user.sql)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("creates a user, finds it case-insensitively, and rejects a duplicate username", async () => {
    const username = freshUsername("Case-Test");
    const created = await createUser(pool, {
      username,
      password: "hunter2hunter2",
      role: "editor",
    });
    expect(created.role).toBe("editor");
    expect(created.isActive).toBe(true);

    const found = await findUserByUsername(pool, username.toUpperCase());
    expect(found?.id).toBe(created.id);

    await expect(
      createUser(pool, { username: username.toLowerCase(), password: "irrelevant", role: "admin" }),
    ).rejects.toBeInstanceOf(DuplicateUsernameError);
  });

  it("refuses to demote, deactivate or delete the last active admin", async () => {
    const username = freshUsername("lone-admin");
    const admin = await createUser(pool, { username, password: "hunter2hunter2", role: "admin" });

    await withOnlyTheseAdminsActive(pool, [admin.id], async () => {
      expect(await countOtherActiveAdmins(pool, admin.id)).toBe(0);

      await expect(updateUserRole(pool, admin.id, "editor")).rejects.toBeInstanceOf(
        LastAdminGuardError,
      );
      await expect(setUserActive(pool, admin.id, false)).rejects.toBeInstanceOf(
        LastAdminGuardError,
      );
      await expect(deleteUser(pool, admin.id)).rejects.toBeInstanceOf(LastAdminGuardError);
    });
  });

  it("allows demoting an admin when another active admin still exists", async () => {
    const other = await createUser(pool, {
      username: freshUsername("other-admin"),
      password: "hunter2hunter2",
      role: "admin",
    });
    const target = await createUser(pool, {
      username: freshUsername("demote-me"),
      password: "hunter2hunter2",
      role: "admin",
    });

    await withOnlyTheseAdminsActive(pool, [other.id, target.id], async () => {
      expect(await countOtherActiveAdmins(pool, target.id)).toBe(1);

      const updated = await updateUserRole(pool, target.id, "editor");
      expect(updated?.role).toBe("editor");

      // Now target is the only non-admin; other is still the sole admin — deleting `other` should
      // itself be refused, proving the guard checks the *current* state, not a stale snapshot.
      await expect(deleteUser(pool, other.id)).rejects.toBeInstanceOf(LastAdminGuardError);
    });
  });
});
