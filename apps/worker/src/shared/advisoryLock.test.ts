import { describe, expect, it } from "vitest";
import { advisoryLockKey } from "./advisoryLock.js";

describe("advisoryLockKey", () => {
  it("is deterministic — the same name always produces the same key", () => {
    expect(advisoryLockKey("some-lock")).toBe(advisoryLockKey("some-lock"));
  });

  it("different names produce different keys", () => {
    expect(advisoryLockKey("some-lock")).not.toBe(advisoryLockKey("some-other-lock"));
  });

  it("returns a bigint, since Postgres advisory lock keys are signed 64-bit integers", () => {
    expect(typeof advisoryLockKey("some-lock")).toBe("bigint");
  });
});
