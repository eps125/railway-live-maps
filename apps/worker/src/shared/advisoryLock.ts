import { createHash } from "node:crypto";

/** Postgres advisory lock keys are signed 64-bit integers — any well-distributed 64 bits works,
 * so this just takes the first 8 bytes of a hash of a fixed name rather than picking an
 * arbitrary literal that'd be easy to accidentally collide with some other lock elsewhere. */
export function advisoryLockKey(name: string): bigint {
  return createHash("sha256").update(`worker-advisory-lock:${name}`).digest().readBigInt64BE(0);
}

/**
 * Shared transaction-scoped mutex between `project-td` and `project-resolver`'s `berth_occupancy`
 * writes. 2026-08-14 production incident: a real Postgres `deadlock detected` (40P01) between the
 * two — `project-td`'s per-batch transaction updates several `berth_occupancy` rows in TD message
 * arrival order (unrelated to row id), while `project-resolver`'s batches update rows in `id` or
 * `decided_at` order; two concurrent transactions touching overlapping rows in different orders
 * can deadlock even though neither has any *logical* dependency on the other's data (see both
 * projectors' own `runProjectTd`/`runProjectResolver` doc comments for the full mechanism).
 *
 * Both acquire this via `pg_advisory_xact_lock` immediately after `BEGIN`, before touching any
 * `berth_occupancy` row — transaction-scoped, so it releases itself on commit or rollback with no
 * explicit unlock needed. This only ever serializes the two loops for the duration of one short
 * batch transaction, not for their whole run, so it doesn't reintroduce the latency coupling that
 * `projector-td`/`projector-resolver` were originally split into separate services to avoid
 * (docs/ARCHITECTURE.md's "initial containers" section).
 */
export const BERTH_OCCUPANCY_WRITE_LOCK_KEY = advisoryLockKey("berth-occupancy-write");
