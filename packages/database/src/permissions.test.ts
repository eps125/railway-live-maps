import { readdirSync, readFileSync } from "node:fs";
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

  it("matches the keys the migrations insert into the permission table", () => {
    // Migration 0056 seeded the table; each later permission adds its own `insert into permission`.
    const dir = new URL("../migrations/", import.meta.url);
    const seeded = readdirSync(dir)
      .filter((name) => name >= "0056" && name.endsWith(".sql"))
      .flatMap((name) => {
        const sql = readFileSync(new URL(name, dir), "utf8");
        return [...sql.matchAll(/insert into permission \(key\) values([^;]*);/g)].flatMap((m) =>
          [...m[1]!.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((k) => k[1]),
        );
      });
    expect([...new Set(seeded)].sort()).toEqual([...PERMISSION_KEYS].sort());
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
