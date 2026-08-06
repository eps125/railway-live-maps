import type { Redis } from "ioredis";
import type { LiveDeltaMessage } from "@railway/protocol";
import type { LiveDeltaSource } from "./deltaSource.js";

/**
 * Optional low-latency `LiveDeltaSource` (`LIVE_WS_REDIS_PUBSUB_ENABLED=true`): subscribes to
 * the `railway:live:{slug}` channel apps/worker's `project-map-deltas` daemon publishes to,
 * instead of polling Postgres. Keys purely on `mapSlug` (not `mapVersionId`) since that's the
 * channel name the publisher uses — the publisher itself only ever publishes for whichever
 * map_version is currently open, so this doesn't need its own version filtering.
 *
 * `subscriberRedis` must be a connection dedicated to this purpose: once a `ioredis` connection
 * issues `SUBSCRIBE`, it can no longer run other commands, so it must never be the same
 * connection used for health checks or anything else.
 */
export function createRedisDeltaSource(subscriberRedis: Redis): LiveDeltaSource {
  const listenersByChannel = new Map<string, Set<(message: LiveDeltaMessage) => void>>();

  subscriberRedis.on("message", (channel: string, raw: string) => {
    const listeners = listenersByChannel.get(channel);
    if (!listeners || listeners.size === 0) return;
    let message: LiveDeltaMessage;
    try {
      message = JSON.parse(raw) as LiveDeltaMessage;
    } catch {
      // A malformed publish shouldn't crash every subscriber on this channel.
      return;
    }
    listeners.forEach((listener) => listener(message));
  });

  return {
    subscribe(_mapVersionId, mapSlug, onDelta) {
      const channel = `railway:live:${mapSlug}`;
      let listeners = listenersByChannel.get(channel);
      if (!listeners) {
        listeners = new Set();
        listenersByChannel.set(channel, listeners);
        subscriberRedis.subscribe(channel).catch((error: unknown) => {
          console.error(`redisDeltaSource: failed to subscribe to ${channel}`, error);
        });
      }
      listeners.add(onDelta);

      return () => {
        const current = listenersByChannel.get(channel);
        if (!current) return;
        current.delete(onDelta);
        if (current.size === 0) {
          listenersByChannel.delete(channel);
          subscriberRedis.unsubscribe(channel).catch((error: unknown) => {
            console.error(`redisDeltaSource: failed to unsubscribe from ${channel}`, error);
          });
        }
      };
    },
  };
}
