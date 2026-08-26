import { describe, expect, it } from "vitest";
import { advisoryLockKey, BERTH_OCCUPANCY_WRITE_LOCK_KEY } from "./advisoryLock.js";

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

describe("BERTH_OCCUPANCY_WRITE_LOCK_KEY", () => {
  it("is the same value every time the module is evaluated — project-td and project-resolver must agree on it", () => {
    // Both projectors import this exact constant rather than deriving it from a name string
    // independently, specifically so there's no chance of the two ever drifting apart (e.g. a
    // typo in one file's literal) and silently no longer sharing the same lock.
    expect(BERTH_OCCUPANCY_WRITE_LOCK_KEY).toBe(advisoryLockKey("berth-occupancy-write"));
  });
});
