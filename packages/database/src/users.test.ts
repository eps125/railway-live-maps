import { describe, expect, it } from "vitest";
import {
  hashPassword,
  isUserRole,
  normalizeUsername,
  roleSatisfies,
  verifyPassword,
} from "./users.js";

describe("isUserRole", () => {
  it("accepts only the two defined roles", () => {
    expect(isUserRole("admin")).toBe(true);
    expect(isUserRole("editor")).toBe(true);
    expect(isUserRole("viewer")).toBe(false);
    expect(isUserRole("")).toBe(false);
  });
});

describe("roleSatisfies", () => {
  it("admin satisfies both admin and editor minimums; editor only satisfies editor", () => {
    expect(roleSatisfies("admin", "admin")).toBe(true);
    expect(roleSatisfies("admin", "editor")).toBe(true);
    expect(roleSatisfies("editor", "editor")).toBe(true);
    expect(roleSatisfies("editor", "admin")).toBe(false);
  });
});

describe("normalizeUsername", () => {
  it("trims and lowercases so case/whitespace variants collide", () => {
    expect(normalizeUsername("  Matt ")).toBe("matt");
    expect(normalizeUsername("MATT")).toBe("matt");
  });
});

describe("hashPassword / verifyPassword", () => {
  it("round-trips a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("rejects (rather than throwing) against a null hash, for a nonexistent-user login attempt", async () => {
    await expect(verifyPassword("anything", null)).resolves.toBe(false);
  });
});
