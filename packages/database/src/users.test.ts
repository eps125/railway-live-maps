import { describe, expect, it } from "vitest";
import { hashPassword, normalizeUsername, verifyPassword } from "./users.js";

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
