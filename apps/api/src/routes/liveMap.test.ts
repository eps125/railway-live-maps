import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { LiveDeltaMessage, LiveWsMessage } from "@railway/protocol";
import { registerLiveMapRoutes } from "./liveMap.js";
import type { LiveDeltaSource } from "../live/deltaSource.js";

type QueryHandler = (
  text: string,
  values?: unknown[],
) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;

function fakePool(handler: QueryHandler): Pool {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values),
  } as unknown as Pool;
}

const compiledBundle = {
  schemaVersion: 1,
  mapId: "lancaster",
  mapName: "Lancaster",
  canvas: { width: 100, height: 100, gridSize: 10 },
  timezone: "Europe/London",
  layers: [],
  elementsById: { "berth-1": { id: "berth-1", type: "berth" } },
  berthBindingIndex: { "PX|0512": "berth-1" },
  sBitBindingIndex: {},
  boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  topologyAdjacency: {},
  continuationLinks: [],
};

function mapVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    slug: "lancaster",
    name: "Lancaster",
    version_number: 1,
    compiled_runtime_bundle: compiledBundle,
    effective_from: new Date("2026-01-01T00:00:00Z"),
    effective_to: null,
    ...overrides,
  };
}

/** A plain `ws.on("message", ...)` listener that resolves a single pending promise loses any
 * message emitted before the *next* `nextMessage()` call re-subscribes — and the fixed route
 * intentionally sends the snapshot and any replayed buffered deltas back-to-back in the same
 * synchronous flush, with no `await` between them (see liveMap.ts). A one-shot listener would
 * silently swallow the second message in exactly the scenario these tests exist to check, so
 * this queues every message as it arrives and hands them out in order on demand instead. */
function createMessageReader(ws: { on: (event: string, cb: (data: unknown) => void) => void }): {
  next: (timeoutMs?: number) => Promise<LiveWsMessage>;
  expectNoMore: (ms?: number) => Promise<void>;
} {
  const queue: LiveWsMessage[] = [];
  const waiters: ((message: LiveWsMessage) => void)[] = [];

  ws.on("message", (data) => {
    const message = JSON.parse((data as Buffer).toString()) as LiveWsMessage;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });

  return {
    next(timeoutMs = 5000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<LiveWsMessage>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for a WS message")),
          timeoutMs,
        );
        waiters.push((message) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
    },
    expectNoMore(ms = 300) {
      if (queue.length > 0) {
        return Promise.reject(new Error(`unexpected message: ${JSON.stringify(queue[0])}`));
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);
        waiters.push((message) => {
          clearTimeout(timeout);
          reject(new Error(`unexpected message: ${JSON.stringify(message)}`));
        });
      });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("GET /api/v1/maps/:slug/live — snapshot/subscribe ordering", () => {
  it("does not drop a delta published while the snapshot's berth_current_state query is still in flight", async () => {
    // Reproduces the "berth stuck occupied forever" bug: the snapshot reads a berth as
    // occupied, and a berth.cleared for it is published (e.g. by project-map-deltas) before
    // the route gets around to subscribing. If subscribe() is called after the snapshot query
    // (the old, buggy order) that clearing delta is gone forever and the map shows a phantom
    // train indefinitely — nothing else ever re-touches that berth to correct it.
    const callOrder: string[] = [];
    let capturedOnDelta: ((message: LiveDeltaMessage) => void) | undefined;
    let releaseBerthQuery: () => void = () => {};
    const berthQueryGate = new Promise<void>((resolve) => {
      releaseBerthQuery = resolve;
    });

    const pool = fakePool(async (text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from berth_current_state")) {
        callOrder.push("query");
        await berthQueryGate;
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "0512",
              description: "2A16",
              occupancy_entered_at: new Date("2026-08-07T14:00:00Z"),
              source_ingestion_sequence: "5",
            },
          ],
        };
      }
      if (text.includes("from td_heartbeat")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const deltaSource: LiveDeltaSource = {
      subscribe(_mapVersionId, _mapSlug, onDelta) {
        callOrder.push("subscribe");
        capturedOnDelta = onDelta;
        return () => {};
      },
    };

    const app = Fastify();
    await app.register(fastifyWebsocket);
    await registerLiveMapRoutes(app, {
      pool,
      deltaSource,
      heartbeatIntervalMs: 60_000,
      versionCheckIntervalMs: 60_000,
    });
    await app.ready();

    const ws = await app.injectWS("/api/v1/maps/lancaster/live");
    const reader = createMessageReader(ws);
    try {
      // Fires the clearing delta while the snapshot query is still gated open — the fixed
      // route must have already subscribed by this point, or this hangs/times out.
      await waitFor(() => capturedOnDelta !== undefined);
      capturedOnDelta!({
        type: "berth.cleared",
        sequence: 6,
        eventAt: "2026-08-07T14:05:00Z",
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
      });
      releaseBerthQuery();

      const snapshot = await reader.next();
      expect(snapshot.type).toBe("snapshot");
      if (snapshot.type !== "snapshot") throw new Error("expected snapshot");
      expect(snapshot.sequence).toBe(5);
      expect(snapshot.state.berths["berth-1"]).toEqual({
        description: "2A16",
        enteredAt: "2026-08-07T14:00:00.000Z",
        runSummary: null,
      });

      const delta = await reader.next();
      expect(delta).toEqual({
        type: "berth.cleared",
        sequence: 6,
        eventAt: "2026-08-07T14:05:00Z",
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
      });

      expect(callOrder).toEqual(["subscribe", "query"]);
    } finally {
      ws.terminate();
      await app.close();
    }
  });

  it("discards a buffered delta already reflected in the snapshot instead of double-applying it", async () => {
    let capturedOnDelta: ((message: LiveDeltaMessage) => void) | undefined;
    let releaseBerthQuery: () => void = () => {};
    const berthQueryGate = new Promise<void>((resolve) => {
      releaseBerthQuery = resolve;
    });

    const pool = fakePool(async (text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from berth_current_state")) {
        await berthQueryGate;
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "0512",
              description: "2A16",
              occupancy_entered_at: new Date("2026-08-07T14:00:00Z"),
              source_ingestion_sequence: "5",
            },
          ],
        };
      }
      if (text.includes("from td_heartbeat")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const deltaSource: LiveDeltaSource = {
      subscribe(_mapVersionId, _mapSlug, onDelta) {
        capturedOnDelta = onDelta;
        return () => {};
      },
    };

    const app = Fastify();
    await app.register(fastifyWebsocket);
    await registerLiveMapRoutes(app, {
      pool,
      deltaSource,
      heartbeatIntervalMs: 60_000,
      versionCheckIntervalMs: 60_000,
    });
    await app.ready();

    const ws = await app.injectWS("/api/v1/maps/lancaster/live");
    const reader = createMessageReader(ws);
    try {
      await waitFor(() => capturedOnDelta !== undefined);
      // Sequence 5 is exactly what the snapshot (below) already reflects — replaying it would
      // be a stale re-apply, not new information.
      capturedOnDelta!({
        type: "berth.updated",
        sequence: 5,
        eventAt: "2026-08-07T14:00:00Z",
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
        description: "2A16",
        enteredAt: "2026-08-07T14:00:00Z",
        runSummary: null,
      });
      releaseBerthQuery();

      const snapshot = await reader.next();
      expect(snapshot.type).toBe("snapshot");

      // No further message should follow — the buffered sequence-5 delta must be discarded,
      // not forwarded a second time after the snapshot already carried it.
      await reader.expectNoMore();
    } finally {
      ws.terminate();
      await app.close();
    }
  });
});
