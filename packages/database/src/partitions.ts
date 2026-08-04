import type { Pool } from "pg";

export interface PartitionedTableSpec {
  /** Parent (partitioned) table name. Must be a plain lowercase snake_case identifier. */
  parentTable: string;
}

export interface EnsureMonthlyPartitionsOptions {
  /** Defaults to now(). */
  referenceDate?: Date;
  /** How many future months to pre-create. Default 3 — keeps normal ingestion from ever
   * writing into the default partition, which would later block carving out that month. */
  monthsAhead?: number;
  /** How many past months to also ensure exist, for late-arriving/backfilled data. */
  monthsBehind?: number;
}

export interface MonthRangeBounds {
  start: Date;
  end: Date;
  /** e.g. "2026_08" */
  suffix: string;
}

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

/** Pure: the [start, end) month range and partition-name suffix for the month containing `date`. */
export function monthRangeBounds(date: Date): MonthRangeBounds {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const suffix = `${year}_${String(month + 1).padStart(2, "0")}`;
  return { start, end, suffix };
}

/**
 * Idempotently creates monthly range partitions for a partitioned table. Safe to re-run
 * (`CREATE TABLE IF NOT EXISTS`). Note: if the default partition already holds rows for a
 * month this is asked to carve out, Postgres will reject the new partition's bounds as
 * overlapping existing default-partition data — this is a real operational hazard, not a
 * bug, which is why `monthsAhead` defaults to 3 (stay well ahead of when rows would land
 * in the default partition in normal operation).
 */
export async function ensureMonthlyPartitions(
  pool: Pool,
  spec: PartitionedTableSpec,
  options: EnsureMonthlyPartitionsOptions = {},
): Promise<{ created: string[] }> {
  const referenceDate = options.referenceDate ?? new Date();
  const monthsAhead = options.monthsAhead ?? 3;
  const monthsBehind = options.monthsBehind ?? 1;
  const parentTable = quoteIdent(spec.parentTable);

  const created: string[] = [];

  for (let offset = -monthsBehind; offset <= monthsAhead; offset += 1) {
    const target = new Date(
      Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + offset, 1),
    );
    const { start, end, suffix } = monthRangeBounds(target);
    const partitionName = `${spec.parentTable}_${suffix}`;

    const before = await pool.query<{ exists: boolean }>(
      "select exists (select 1 from pg_class where relname = $1) as exists",
      [partitionName],
    );
    if (before.rows[0]?.exists) {
      continue;
    }

    const sql = `create table if not exists ${quoteIdent(partitionName)}
      partition of ${parentTable}
      for values from ('${start.toISOString()}') to ('${end.toISOString()}')`;
    await pool.query(sql);
    created.push(partitionName);
  }

  return { created };
}
