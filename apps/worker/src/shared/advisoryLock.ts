import { createHash } from "node:crypto";

/** Postgres advisory lock keys are signed 64-bit integers — any well-distributed 64 bits works,
 * so this just takes the first 8 bytes of a hash of a fixed name rather than picking an
 * arbitrary literal that'd be easy to accidentally collide with some other lock elsewhere. */
export function advisoryLockKey(name: string): bigint {
  return createHash("sha256").update(`worker-advisory-lock:${name}`).digest().readBigInt64BE(0);
}

// `BERTH_OCCUPANCY_WRITE_LOCK_KEY` (a shared mutex between project-td and project-resolver's
// berth_occupancy writes, added 2026-08-14 after a real 40P01 deadlock between the two) was
// removed 2026-09-01: migration 0022 dropped `berth_occupancy.resolved_run_id`/
// `resolution_status`, so project-resolver no longer writes to `berth_occupancy` at all — only
// `berth_run_resolution`, its own table, which project-td never touches. With only one writer
// left, the two transactions can no longer deadlock on overlapping rows, so the lock had nothing
// left to protect. Also removed the throttling it caused: under resolver backlog load, project-td
// batches were observed queuing behind it, stalling live berth positions (2026-08-31/09-01
// incidents). If a genuine cross-projector `berth_occupancy` writer reappears, reintroduce a
// lock scoped to that specific case rather than resurrecting this one wholesale.
