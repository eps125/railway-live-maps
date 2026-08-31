import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import {
  advanceCheckpoint,
  ensureCheckpoint,
  getCheckpoint,
  getOrCreateProjectionDefinition,
} from "./checkpoint.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

describe("projection checkpoint framework (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("round-trips through create -> ensure -> advance -> read", async () => {
    // Unique name per run keeps this test isolated from repeat runs against a shared DB.
    const name = `test-projection-${randomUUID()}`;

    const definitionId = await getOrCreateProjectionDefinition(pool, name, 1, "config-hash-a");
    expect(definitionId).toBeTruthy();

    // Idempotent: re-registering the same name+codeVersion returns the same id.
    const definitionIdAgain = await getOrCreateProjectionDefinition(pool, name, 1, "config-hash-b");
    expect(definitionIdAgain).toBe(definitionId);

    await ensureCheckpoint(pool, definitionId);
    const initial = await getCheckpoint(pool, definitionId);
    expect(initial?.lastIngestionSequence).toBe("0");
    expect(initial?.lastCompletedAt).toBeNull();

    await advanceCheckpoint(pool, definitionId, "42");
    const advanced = await getCheckpoint(pool, definitionId);
    expect(advanced?.lastIngestionSequence).toBe("42");
    expect(advanced?.lastCompletedAt).not.toBeNull();
  });

  it("advanceCheckpoint is monotonic — a lower (stale/concurrent) value never rewinds it", async () => {
    const name = `test-projection-${randomUUID()}`;
    const definitionId = await getOrCreateProjectionDefinition(pool, name, 1, "h");
    await ensureCheckpoint(pool, definitionId);

    await advanceCheckpoint(pool, definitionId, "1000");
    await advanceCheckpoint(pool, definitionId, "500"); // stale write — ignored
    expect((await getCheckpoint(pool, definitionId))?.lastIngestionSequence).toBe("1000");

    await advanceCheckpoint(pool, definitionId, "1500"); // genuine forward progress — applied
    expect((await getCheckpoint(pool, definitionId))?.lastIngestionSequence).toBe("1500");
  });

  it("returns undefined for a checkpoint that was never ensured", async () => {
    const checkpoint = await getCheckpoint(pool, "999999999");
    expect(checkpoint).toBeUndefined();
  });
});
