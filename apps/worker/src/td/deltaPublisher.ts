import type { Redis } from "ioredis";

/**
 * The live map has two delta publishers — the `ingest-td` inline path (ADR 0003 Tier 3) and the
 * `projector-td-live` catch-up daemon — plus a third `berth_current_state` writer, `project-td`,
 * that never publishes. Both publishers derive the same value for the same event, so a naive
 * "publish after you write" double-sends every berth step; and any dedupe that keys off
 * `berth_current_state` breaks the moment the silent `project-td` wins the write race (it
 * advances the row, both publishers think "already done", the delta is dropped and the berth
 * freezes on the map until a refresh).
 *
 * Fix: a per-berth "last published sequence" that lives in Redis and is owned by the publishers.
 * `publishDeltaIfNewer` checks it, advances it, and does the `PUBLISH` in a single atomic Lua
 * script — one round-trip, replacing the plain `PUBLISH`. Whichever publisher reaches an event
 * first sends it; the other's call is a no-op. `project-td` never calls this, so it can never
 * suppress a real delta.
 */
export interface DeltaPublisher {
  /**
   * Atomically: publish `message` on `railway:live:<mapSlug>` iff `sequence` is strictly greater
   * than the last sequence published for `berthKey` on that map. Returns 1 if it published, 0 if
   * it was suppressed as an already-sent (or older) duplicate.
   */
  publishDeltaIfNewer(
    mapSlug: string,
    berthKey: string,
    sequence: number,
    message: string,
  ): Promise<number>;
}

/**
 * KEYS[1] = `railway:live:<slug>:pubseq`  (hash: berthKey -> last published ingestion_sequence)
 * KEYS[2] = `railway:live:<slug>`         (pub/sub channel)
 * ARGV[1] = berthKey  ("<tdArea> <berth>")
 * ARGV[2] = sequence  (integer, as a string)
 * ARGV[3] = message JSON
 *
 * The hash field count is bounded by berths bound to the map; the 1-day EXPIRE (refreshed on
 * every publish) reaps a map's watermark ~24h after its last delta. Redis here is memory-only
 * (`--save "" --appendonly no`), so a Redis restart just re-seeds the watermark on the next
 * delta per berth — at worst one duplicate per berth, once, right after a restart.
 */
export const PUBLISH_IF_NEWER_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur and tonumber(cur) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], 86400)
redis.call('PUBLISH', KEYS[2], ARGV[3])
return 1
`.trim();

/** Wrap an ioredis client so the live projectors publish through the dedupe script. */
export function createRedisDeltaPublisher(redis: Pick<Redis, "eval">): DeltaPublisher {
  return {
    async publishDeltaIfNewer(mapSlug, berthKey, sequence, message) {
      const result = await redis.eval(
        PUBLISH_IF_NEWER_LUA,
        2,
        `railway:live:${mapSlug}:pubseq`,
        `railway:live:${mapSlug}`,
        berthKey,
        String(sequence),
        message,
      );
      return Number(result);
    },
  };
}
