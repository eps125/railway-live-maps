import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

// The exact statement shape the garner bridge uses (apps/worker/src/garner/bridge.ts,
// TRUST_MOVEMENT_CONFLICT) — kept literal here so a drift between the two fails loudly.
const INSERT = `insert into trust_movement (trust_id, created, loc_stanox, actual_timestamp, flags)
  values ($1, $2, $3, $4, $5)
  on conflict (trust_id, created, loc_stanox, actual_timestamp, flags) do nothing`;

describe("trust_movement idempotency key (migration 0041, integration)", () => {
  const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
  const created = new Date("2026-09-20T10:26:49Z");
  const actual = new Date("2026-09-20T10:14:00Z");

  afterAll(async () => {
    await pool.query(`delete from trust_movement where trust_id = $1`, [trustId]);
    await pool.end();
  });

  it("keeps an arrival and a departure reported at the same place in the same minute", async () => {
    // Real shape (garner, 2026-09-20: trust_id 012H62MJ20 at STANOX 01047): the two reports share
    // trust_id/created/loc_stanox/actual_timestamp and differ only in flags (event type 341/342).
    // The old 4-column key kept only one of them.
    await pool.query(INSERT, [trustId, created, "01047", actual, 342]);
    await pool.query(INSERT, [trustId, created, "01047", actual, 341]);
    // An exact repeat report is still deduplicated.
    await pool.query(INSERT, [trustId, created, "01047", actual, 341]);

    const rows = await pool.query<{ flags: number }>(
      `select flags from trust_movement where trust_id = $1 order by flags`,
      [trustId],
    );
    expect(rows.rows.map((row) => row.flags)).toEqual([341, 342]);
  });
});
