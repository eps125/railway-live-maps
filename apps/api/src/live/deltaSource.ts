import type { LiveDeltaMessage } from "@railway/protocol";

/**
 * Milestone 6: the source of live map deltas for a given published `map_version`. Two
 * implementations exist — `pollingDeltaSource.ts` (default, no extra infrastructure) and
 * `redisDeltaSource.ts` (optional low-latency fan-out, `LIVE_WS_REDIS_PUBSUB_ENABLED=true`).
 * `routes/liveMap.ts` depends only on this interface, so switching adapters never touches the
 * WebSocket route itself.
 */
export interface LiveDeltaSource {
  /** Registers `onDelta` for every future delta affecting `mapVersionId` (published under
   * `mapSlug`). Both are passed because adapters key on whichever is natural for them: the
   * polling adapter queries by `map_version_id`; the Redis adapter subscribes by slug, since
   * that's the channel name the worker's publisher uses. Returns an unsubscribe function —
   * call it when the socket closes. */
  subscribe(
    mapVersionId: string,
    mapSlug: string,
    onDelta: (message: LiveDeltaMessage) => void,
  ): () => void;
}
