import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import { createAccessCode, findAccessCode } from "./accessCodes.js";
import { checkPermissionTable, PERMISSION_KEYS } from "./permissions.js";
import {
  createUserType,
  deleteUserType,
  findUserTypeByName,
  listUserTypes,
  loadPermissionMatrix,
  SystemUserTypeError,
  updateUserType,
  UserTypeInUseError,
} from "./userTypes.js";
import { createUser } from "./users.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

describe("user types (integration, migration 0056)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("has a permission table that matches the registry", async () => {
    expect(await checkPermissionTable(pool)).toEqual({ missingFromTable: [], unknownInTable: [] });
  });

  it("seeds the six types, with Admin holding everything", async () => {
    const types = await listUserTypes(pool);
    const names = types.map((t) => t.name);
    for (const name of [
      "No user (public)",
      "Basic User",
      "Enhanced User",
      "Editor",
      "Enhanced Editor",
      "Admin",
    ]) {
      expect(names).toContain(name);
    }
    const admin = types.find((t) => t.systemKey === "admin")!;
    expect(admin.grantsAll).toBe(true);
    expect(admin.permissions).toEqual([...PERMISSION_KEYS]);
    const editor = types.find((t) => t.name === "Editor")!;
    expect(editor.permissions).toContain("maps.edit");
    expect(editor.permissions).not.toContain("maps.publish");
    expect(editor.permissions.some((p) => p.startsWith("tools."))).toBe(false);
    const enhancedEditor = types.find((t) => t.name === "Enhanced Editor")!;
    expect(enhancedEditor.permissions).toContain("maps.publish");
    expect(enhancedEditor.permissions).not.toContain("maps.manage");
    expect(enhancedEditor.permissions.some((p) => p.startsWith("admin."))).toBe(false);

    const matrix = await loadPermissionMatrix(pool);
    expect(matrix.byType.get(admin.id)?.has("admin.users")).toBe(true);
  });

  it("refuses to change Admin or delete a built-in type", async () => {
    const admin = (await findUserTypeByName(pool, "Admin"))!;
    const publicType = (await findUserTypeByName(pool, "No user (public)"))!;
    await expect(updateUserType(pool, admin.id, { permissions: [] })).rejects.toBeInstanceOf(
      SystemUserTypeError,
    );
    await expect(deleteUserType(pool, publicType.id)).rejects.toBeInstanceOf(SystemUserTypeError);
  });

  it("creates, re-permissions and deletes a type, refusing deletion while in use", async () => {
    const type = await createUserType(pool, {
      name: `Trial ${randomUUID()}`,
      permissions: ["site.view", "maps.view_public"],
    });
    expect(type.permissions).toEqual(["maps.view_public", "site.view"]);

    const updated = await updateUserType(pool, type.id, {
      permissions: ["site.view", "map.playback"],
    });
    expect(updated?.permissions).toEqual(["map.playback", "site.view"]);

    const user = await createUser(pool, {
      username: `typed-${randomUUID()}`,
      password: "hunter2hunter2",
      userTypeId: type.id,
    });
    await expect(deleteUserType(pool, type.id)).rejects.toBeInstanceOf(UserTypeInUseError);
    await pool.query(`delete from app_user where id = $1`, [user.id]);
    expect(await deleteUserType(pool, type.id)).toBe(true);
  });

  it("never lets an access code carry an admin permission", async () => {
    const type = await createUserType(pool, {
      name: `Code type ${randomUUID()}`,
      permissions: ["site.view"],
    });
    const code = await createAccessCode(
      pool,
      {
        label: "type code",
        grantKind: "user_type",
        userTypeId: type.id,
        permissions: [],
        mapLimit: "none",
        mapIds: [],
        maxUses: null,
        accessSeconds: 3600,
        validUntil: null,
      },
      "test",
    );
    expect((await findAccessCode(pool, code.id))?.userTypeName).toBe(type.name);

    // The API refuses this first; the database refuses it too.
    await expect(
      updateUserType(pool, type.id, { permissions: ["site.view", "admin.users"] }),
    ).rejects.toBeInstanceOf(SystemUserTypeError);
    await expect(
      pool.query(`insert into user_type_permission values ($1, 'admin.users')`, [type.id]),
    ).rejects.toThrow(/cannot hold admin permissions/);

    const admin = (await findUserTypeByName(pool, "Admin"))!;
    await expect(
      pool.query(`update access_code set user_type_id = $1 where id = $2`, [admin.id, code.id]),
    ).rejects.toThrow(/cannot grant/);

    const custom = await createAccessCode(
      pool,
      {
        label: "custom code",
        grantKind: "custom",
        userTypeId: null,
        permissions: ["site.view", "maps.edit"],
        mapLimit: "none",
        mapIds: [],
        maxUses: null,
        accessSeconds: 3600,
        validUntil: null,
      },
      "test",
    );
    expect(custom.permissions).toEqual(["maps.edit", "site.view"]);
    await expect(
      pool.query(`insert into access_code_permission values ($1, 'admin.audit_log')`, [custom.id]),
    ).rejects.toThrow(/access_code_permission_not_admin/);
  });
});
