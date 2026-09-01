import { createPool } from "@railway/database";
import type { Config } from "../config.js";

/**
 * `prune-partitions --before <YYYY-MM-DD> [--execute]` — reclaims disk by DROPping whole monthly
 * partitions whose entire range is older than the cutoff (docs/IMPLEMENTATION_PLAN.md Milestone
 * 15, step 4). Dry-run by default: prints every partition it *would* drop with its size and the
 * total reclaimable, and refuses `--execute` for a cutoff less than PRUNE_MIN_AGE_DAYS old (a
 * guard against fat-fingering a recent date).
 *
 * Partitions are dropped in foreign-key-safe order — referencing partitioned tables before the
 * tables they reference:
 *
 *   (td_berth_event, td_s_event, td_s_bit_transition) → berth_occupancy → raw_feed_event
 *
 * This deletes retained data and is irreversible from Postgres — the raw NR frames still live in
 * the S3/MinIO archive (raw_archive_object), so a pruned month can be rehydrated/reprojected from
 * there if ever needed. Run it deliberately, off-peak, and read the dry-run output first.
 *
 * `train_run_event` was removed from this list when RLM's bespoke run model was dropped (ADR
 * 0002, migration 0025). The garner `trust_*` mirror tables are unpartitioned and so not pruned
 * here yet — see docs/IMPLEMENTATION_PLAN.md Milestone 15 step 4.
 */
const PRUNE_MIN_AGE_DAYS = 14;

// Referencing side first, referenced side last.
const DROP_ORDER = [
  "td_berth_event",
  "td_s_event",
  "td_s_bit_transition",
  "berth_occupancy",
  "raw_feed_event",
] as const;

interface PartitionRow {
  partition: string;
  size_bytes: string;
}

function parseArgs(argv: string[]): { before: Date; execute: boolean } | { error: string } {
  const beforeIdx = argv.indexOf("--before");
  const beforeRaw = beforeIdx >= 0 ? argv[beforeIdx + 1] : undefined;
  if (!beforeRaw || !/^\d{4}-\d{2}-\d{2}$/.test(beforeRaw)) {
    return { error: "prune-partitions requires --before <YYYY-MM-DD>" };
  }
  const before = new Date(`${beforeRaw}T00:00:00Z`);
  if (Number.isNaN(before.getTime())) {
    return { error: `prune-partitions --before: not a valid date: ${beforeRaw}` };
  }
  return { before, execute: argv.includes("--execute") };
}

/** A monthly partition `<parent>_<YYYY>_<MM>` is prunable iff the *first day of the next month*
 * after its own month is still <= cutoff, i.e. the whole partition range is strictly before it.
 * `MM` is 1-12; `Date.UTC(year, month, 1)` with the 0-indexed `month` argument therefore already
 * lands on the first of the *following* month. Exported for its own unit test. */
export function partitionMonthEndsBefore(partition: string, parent: string, cutoff: Date): boolean {
  const m = new RegExp(`^${parent}_(\\d{4})_(\\d{2})$`).exec(partition);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const nextMonthStart = new Date(Date.UTC(year, month, 1)); // month is already +1 in 0-indexed terms
  return nextMonthStart.getTime() <= cutoff.getTime();
}

export async function runPrunePartitions(config: Config, argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const { before, execute } = parsed;

  const ageDays = (Date.now() - before.getTime()) / 86_400_000;
  if (execute && ageDays < PRUNE_MIN_AGE_DAYS) {
    console.error(
      `prune-partitions: refusing --execute for a cutoff only ${ageDays.toFixed(1)} days old ` +
        `(minimum ${PRUNE_MIN_AGE_DAYS}). Re-run without --execute to preview, or pick an older date.`,
    );
    process.exitCode = 1;
    return;
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const toDrop: Array<{ parent: string; partition: string; sizeBytes: bigint }> = [];

    for (const parent of DROP_ORDER) {
      const { rows } = await pool.query<PartitionRow>(
        `select c.relname as partition,
                pg_total_relation_size(c.oid)::text as size_bytes
         from pg_inherits i
         join pg_class c on c.oid = i.inhrelid
         join pg_class p on p.oid = i.inhparent
         where p.relname = $1`,
        [parent],
      );
      for (const row of rows) {
        if (partitionMonthEndsBefore(row.partition, parent, before)) {
          toDrop.push({ parent, partition: row.partition, sizeBytes: BigInt(row.size_bytes) });
        }
      }
    }

    if (toDrop.length === 0) {
      console.log(`prune-partitions: nothing to drop before ${before.toISOString().slice(0, 10)}`);
      return;
    }

    const total = toDrop.reduce((sum, p) => sum + p.sizeBytes, 0n);
    console.log(
      `prune-partitions: ${execute ? "DROPPING" : "would drop"} ${toDrop.length} partition(s) ` +
        `before ${before.toISOString().slice(0, 10)}, ~${(Number(total) / 1024 ** 3).toFixed(1)} GiB:`,
    );
    for (const p of toDrop) {
      console.log(`  ${p.partition}  ${(Number(p.sizeBytes) / 1024 ** 3).toFixed(2)} GiB`);
    }

    if (!execute) {
      console.log("prune-partitions: dry run — re-run with --execute to drop.");
      return;
    }

    // One transaction: DROP TABLE is transactional in Postgres, so a foreign-key blocker (a
    // referencing table not in DROP_ORDER) rolls the whole prune back cleanly rather than
    // leaving it half-applied. The error names the constraint/table to add next.
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const parent of DROP_ORDER) {
        for (const p of toDrop.filter((x) => x.parent === parent)) {
          await client.query(`drop table if exists "${p.partition}"`);
          console.log(`  dropped ${p.partition}`);
        }
      }
      await client.query("commit");
      console.log(
        `prune-partitions: done (~${(Number(total) / 1024 ** 3).toFixed(1)} GiB reclaimed)`,
      );
    } catch (error) {
      await client.query("rollback");
      console.error(
        "prune-partitions: rolled back — a foreign key from a table not in DROP_ORDER blocked a " +
          "drop. Add that table (referencing side first) to DROP_ORDER and retry.",
        error,
      );
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
