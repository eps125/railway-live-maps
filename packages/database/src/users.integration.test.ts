import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "./pool.js";
import {
  createUser,
  deleteUser,
  DuplicateUsernameError,
  findUserByUsername,
  InvalidUserTypeError,
  setUserActive,
  updateUserType,
} from "./users.js";
import { countActiveManagers, findUserTypeByName, LastManagerGuardError } from "./userTypes.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function freshUsername(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

let adminTypeId = "";
let editorTypeId = "";
let publicTypeId = "";

/**
 * The "last manager" guard is a global-state check, and this integration suite shares one real
 * database across every test file (no per-test rollback) — so a test asserting "this is *the*
 * last manager" would be flaky against any other admin left behind by another test. This
 * temporarily deactivates every other active user for the duration of `fn`, then restores them.
 */
async function withOnlyTheseUsersActive<T>(
  db: Pool,
  keepActiveIds: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const { rows: others } = await db.query<{ id: string }>(
    `select id::text from app_user where is_active = true and id != all($1::bigint[])`,
    [keepActiveIds],
  );
  await db.query(`update app_user set is_active = false where id = any($1::bigint[])`, [
    others.map((row) => row.id),
  ]);
  try {
    return await fn();
  } finally {
    await db.query(`update app_user set is_active = true where id = any($1::bigint[])`, [
      others.map((row) => row.id),
    ]);
  }
}

describe("users (integration, migrations 0029 + 0056)", () => {
  beforeAll(async () => {
    adminTypeId = (await findUserTypeByName(pool, "Admin"))!.id;
    editorTypeId = (await findUserTypeByName(pool, "Editor"))!.id;
    publicTypeId = (await findUserTypeByName(pool, "No user (public)"))!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a user with a type, finds it case-insensitively, and rejects a duplicate", async () => {
    const username = freshUsername("Case-Test");
    const created = await createUser(pool, {
      username,
      password: "hunter2hunter2",
      userTypeId: editorTypeId,
    });
    expect(created.userTypeId).toBe(editorTypeId);
    expect(created.userTypeName).toBe("Editor");
    expect(created.isActive).toBe(true);

    const found = await findUserByUsername(pool, username.toUpperCase());
    expect(found?.id).toBe(created.id);

    await expect(
      createUser(pool, {
        username: username.toLowerCase(),
        password: "irrelevant",
        userTypeId: adminTypeId,
      }),
    ).rejects.toBeInstanceOf(DuplicateUsernameError);
  });

  it("never gives a user the public type", async () => {
    await expect(
      createUser(pool, {
        username: freshUsername("public"),
        password: "hunter2hunter2",
        userTypeId: publicTypeId,
      }),
    ).rejects.toBeInstanceOf(InvalidUserTypeError);
  });

  it("keeps the legacy role column in step for rollback", async () => {
    const user = await createUser(pool, {
      username: freshUsername("legacy"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });
    const role = async (): Promise<string> =>
      (await pool.query<{ role: string }>(`select role from app_user where id = $1`, [user.id]))
        .rows[0]!.role;
    expect(await role()).toBe("admin");
    await updateUserType(pool, user.id, editorTypeId);
    expect(await role()).toBe("editor");
  });

  it("refuses to move, deactivate or delete the last user who can manage users", async () => {
    const admin = await createUser(pool, {
      username: freshUsername("lone-admin"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });

    await withOnlyTheseUsersActive(pool, [admin.id], async () => {
      expect(await countActiveManagers(pool, { excludingUserId: admin.id })).toBe(0);
      await expect(updateUserType(pool, admin.id, editorTypeId)).rejects.toBeInstanceOf(
        LastManagerGuardError,
      );
      await expect(setUserActive(pool, admin.id, false)).rejects.toBeInstanceOf(
        LastManagerGuardError,
      );
      await expect(deleteUser(pool, admin.id)).rejects.toBeInstanceOf(LastManagerGuardError);
    });
  });

  it("allows moving an admin when another manager remains", async () => {
    const other = await createUser(pool, {
      username: freshUsername("other-admin"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });
    const target = await createUser(pool, {
      username: freshUsername("demote-me"),
      password: "hunter2hunter2",
      userTypeId: adminTypeId,
    });

    await withOnlyTheseUsersActive(pool, [other.id, target.id], async () => {
      const updated = await updateUserType(pool, target.id, editorTypeId);
      expect(updated?.userTypeName).toBe("Editor");
      // `other` is now the only manager: the guard reads the current state, not a snapshot.
      await expect(deleteUser(pool, other.id)).rejects.toBeInstanceOf(LastManagerGuardError);
    });
  });
});
