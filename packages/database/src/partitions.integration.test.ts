import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import { ensureMonthlyPartitions } from "./partitions.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

// A minimal standalone partitioned table exercises ensureMonthlyPartitions' generic
// mechanism without the FK setup real raw_feed_event/td_berth_event rows would need —
// the partitioning behavior itself is identical regardless of the parent's other columns.
const TEST_TABLE = "partition_hazard_test";

describe("ensureMonthlyPartitions (integration)", () => {
  beforeAll(async () => {
    await pool.query(
      `create table if not exists ${TEST_TABLE} (id bigserial, event_at timestamptz not null) partition by range (event_at)`,
    );
    await pool.query(
      `create table if not exists ${TEST_TABLE}_default partition of ${TEST_TABLE} default`,
    );
  });

  afterAll(async () => {
    await pool.query(`drop table if exists ${TEST_TABLE} cascade`);
    await pool.end();
  });

  it("creates monthly partitions and is idempotent on re-run", async () => {
    const referenceDate = new Date("2031-06-15T00:00:00Z");

    const first = await ensureMonthlyPartitions(
      pool,
      { parentTable: TEST_TABLE },
      { referenceDate, monthsAhead: 1, monthsBehind: 0 },
    );
    expect(first.created.sort()).toEqual([`${TEST_TABLE}_2031_06`, `${TEST_TABLE}_2031_07`]);

    const second = await ensureMonthlyPartitions(
      pool,
      { parentTable: TEST_TABLE },
      { referenceDate, monthsAhead: 1, monthsBehind: 0 },
    );
    expect(second.created).toEqual([]);
  });

  it("routes a row in a not-yet-partitioned month to the default partition without error", async () => {
    await pool.query(`insert into ${TEST_TABLE} (event_at) values ('2032-01-01T00:00:00Z')`);

    const result = await pool.query<{ rel: string }>(
      `select tableoid::regclass::text as rel from ${TEST_TABLE} where event_at = '2032-01-01T00:00:00Z'`,
    );
    expect(result.rows[0]?.rel).toBe(`${TEST_TABLE}_default`);
  });

  it("throws when asked to carve out a month that already has default-partition data", async () => {
    await pool.query(`insert into ${TEST_TABLE} (event_at) values ('2033-03-15T00:00:00Z')`);

    await expect(
      ensureMonthlyPartitions(
        pool,
        { parentTable: TEST_TABLE },
        { referenceDate: new Date("2033-03-01T00:00:00Z"), monthsAhead: 0, monthsBehind: 0 },
      ),
    ).rejects.toThrow(/default partition/);
  });
});
