import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EDITOR_PERMISSIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_KEYS,
  PERMISSIONS,
  isCodeGrantable,
  isPermission,
} from "./permissions.js";
import { isManagerSet } from "./userTypes.js";

describe("permission registry", () => {
  it("has unique keys in the `category.name` form the permission table accepts", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("puts every permission in a known category", () => {
    const categories = new Set(PERMISSION_CATEGORIES.map((c) => c.key));
    for (const p of PERMISSIONS) expect(categories.has(p.category)).toBe(true);
  });

  it("matches the keys migration 0056 inserts into the permission table", () => {
    const sql = readFileSync(
      new URL("../migrations/0056_user_types_and_permissions.sql", import.meta.url),
      "utf8",
    );
    const block = sql.slice(sql.indexOf("insert into permission"), sql.indexOf("-- `system_key`"));
    const seeded = [...block.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
    expect([...seeded].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("recognises only registered keys", () => {
    expect(isPermission("map.playback")).toBe(true);
    expect(isPermission("map.teleport")).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it("lets a code grant editor permissions but never admin ones", () => {
    expect(EDITOR_PERMISSIONS).toContain("maps.publish");
    expect(isCodeGrantable("maps.publish")).toBe(true);
    expect(isCodeGrantable("admin.users")).toBe(false);
  });

  it("calls a set a manager set only with both users and user types", () => {
    expect(isManagerSet(["admin.users", "admin.user_types"])).toBe(true);
    expect(isManagerSet(["admin.users"])).toBe(false);
  });
});
