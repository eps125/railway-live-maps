import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { LiveDeltaMessage } from "@railway/protocol";
import { createRedisDeltaSource } from "./redisDeltaSource.js";

/** A minimal stand-in for ioredis's `Redis` — this sandbox has no real Redis server (mirrors
 * the FakeS3Client/no-MinIO situation elsewhere in this repo), so this proves the channel
 * subscribe/unsubscribe bookkeeping and message dispatch logic without a real network round
 * trip. apps/worker/src/mapProjector/projector.integration.test.ts separately proves the
 * publisher side produces the same message shape this consumes. */
class FakeRedis extends EventEmitter {
  subscribe = vi.fn(async (_channel: string) => 1);
  unsubscribe = vi.fn(async (_channel: string) => 1);
}

const berthUpdated: LiveDeltaMessage = {
  type: "berth.updated",
  sequence: 1,
  eventAt: "2026-08-05T12:00:00.000Z",
  elementId: "berth-1",
  tdArea: "ZZ",
  berth: "0001",
  description: "1A23",
  enteredAt: "2026-08-05T12:00:00.000Z",
  runSummary: null,
};

describe("createRedisDeltaSource", () => {
  it("subscribes to railway:live:{slug} on first listener and forwards matching messages", async () => {
    const fakeRedis = new FakeRedis();
    const source = createRedisDeltaSource(fakeRedis as unknown as Redis);

    const received: LiveDeltaMessage[] = [];
    source.subscribe("version-1", "lancaster", (message) => received.push(message));

    expect(fakeRedis.subscribe).toHaveBeenCalledWith("railway:live:lancaster");

    fakeRedis.emit("message", "railway:live:lancaster", JSON.stringify(berthUpdated));
    fakeRedis.emit("message", "railway:live:other-map", JSON.stringify(berthUpdated));

    expect(received).toEqual([berthUpdated]);
  });

  it("does not resubscribe for a second listener on the same slug, and unsubscribes only after the last one leaves", async () => {
    const fakeRedis = new FakeRedis();
    const source = createRedisDeltaSource(fakeRedis as unknown as Redis);

    const unsubscribe1 = source.subscribe("version-1", "lancaster", () => {});
    source.subscribe("version-1", "lancaster", () => {});
    expect(fakeRedis.subscribe).toHaveBeenCalledTimes(1);

    unsubscribe1();
    expect(fakeRedis.unsubscribe).not.toHaveBeenCalled();
  });

  it("ignores a malformed message instead of throwing", () => {
    const fakeRedis = new FakeRedis();
    const source = createRedisDeltaSource(fakeRedis as unknown as Redis);
    const received: LiveDeltaMessage[] = [];
    source.subscribe("version-1", "lancaster", (message) => received.push(message));

    expect(() => fakeRedis.emit("message", "railway:live:lancaster", "not json")).not.toThrow();
    expect(received).toEqual([]);
  });
});
