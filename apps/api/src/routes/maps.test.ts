import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerMapRoutes } from "./maps.js";
import { clearMapVersionCache } from "../lib/mapVersion.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

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
  elementsById: {
    "berth-1": { id: "berth-1", type: "berth" },
    "signal-1": { id: "signal-1", type: "signal" },
  },
  berthBindingIndex: { "PX|0512": "berth-1" },
  sBitBindingIndex: {},
  placeBindingIndex: [],
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

// Version content is cached by id (immutable in production); these tests reuse one id with
// different bundles, so start each from an empty cache.
beforeEach(() => clearMapVersionCache());

describe("map routes", () => {
  it("GET /api/v1/maps lists published maps with live-data status", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from td_heartbeat")) {
        return { rows: [{ last_activity_at: new Date() }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/maps" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      maps: [{ slug: "lancaster", name: "Lancaster", mapVersion: 1, liveDataStatus: "ok" }],
    });
  });

  it("GET /api/v1/maps/:slug/definition returns the compiled bundle", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/maps/lancaster/definition" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mapSlug).toBe("lancaster");
    expect(body.mapVersion).toBe(1);
    expect(body.definition.berthBindingIndex).toEqual({ "PX|0512": "berth-1" });
  });

  it("GET /api/v1/maps/:slug/definition 404s when no version is effective", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/maps/nowhere/definition" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MAP_NOT_FOUND");
  });

  it("GET /api/v1/maps/:slug/state returns current berth/signal state", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from berth_current_state")) {
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "0512",
              description: "2A16",
              occupancy_id: null,
              occupancy_entered_at: new Date("2026-08-04T12:00:00Z"),
              source_ingestion_sequence: "42",
            },
          ],
        };
      }
      if (text.includes("from td_heartbeat")) return { rows: [{ last_heartbeat_at: new Date() }] };
      if (text.includes("from feed_gap")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/maps/lancaster/state" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe("live");
    expect(body.berths["berth-1"]).toEqual({
      description: "2A16",
      enteredAt: "2026-08-04T12:00:00.000Z",
    });
    expect(body.signals["signal-1"]).toEqual({ state: "blank" });
    expect(body.sourceSequence).toBe(42);
  });

  it("joins a combined berth's occupied members into one element's state (owner request 2026-09-17)", async () => {
    // Two tdBerth bindings ("PX|A001", "PX|B001") sharing one map element ("berth-combined") —
    // a split-berth group for permissive working. Both currently occupied; the join must show
    // both, in combinedOrder, not silently drop one (the exact regression this milestone fixed).
    const combinedBundle = {
      ...compiledBundle,
      elementsById: { "berth-combined": { id: "berth-combined", type: "berth" } },
      berthBindingIndex: { "PX|A001": "berth-combined", "PX|B001": "berth-combined" },
      berthBindingOrder: { "PX|A001": 1, "PX|B001": 2 },
    };
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) {
        return { rows: [mapVersionRow({ compiled_runtime_bundle: combinedBundle })] };
      }
      if (text.includes("from berth_current_state")) {
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "A001",
              description: "1A23",
              occupancy_id: null,
              occupancy_entered_at: new Date("2026-08-04T12:00:00Z"),
              source_ingestion_sequence: "10",
            },
            {
              td_area: "PX",
              berth_code: "B001",
              description: "1B99",
              occupancy_id: null,
              occupancy_entered_at: new Date("2026-08-04T12:05:00Z"),
              source_ingestion_sequence: "11",
            },
          ],
        };
      }
      if (text.includes("from td_heartbeat")) return { rows: [{ last_heartbeat_at: new Date() }] };
      if (text.includes("from feed_gap")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/maps/lancaster/state" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.berths["berth-combined"]).toEqual({
      description: "1A23 1B99",
      enteredAt: "2026-08-04T12:05:00.000Z",
    });
  });

  it("GET /api/v1/maps/:slug/state?at= reconstructs historical state from berth_occupancy", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from berth_occupancy bo")) {
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "0512",
              description: "1S99",
              entered_at: new Date("2026-05-01T09:58:00Z"),
              left_at: null,
            },
          ],
        };
      }
      if (text.includes("from td_berth_event be")) return { rows: [{ source_sequence: "77" }] };
      if (text.includes("from feed_gap")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });
    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/maps/lancaster/state?at=2026-05-01T10:00:00Z",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe("historical");
    expect(body.asOf).toBe("2026-05-01T10:00:00.000Z");
    expect(body.berths["berth-1"]).toEqual({
      description: "1S99",
      enteredAt: "2026-05-01T09:58:00.000Z",
    });
    expect(body.sourceSequence).toBe(77);
  });

  it("GET /api/v1/maps/:slug/state?at= 404s when no version was effective then", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/maps/lancaster/state?at=2020-01-01T00:00:00Z",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MAP_NOT_FOUND");
  });

  it("GET /api/v1/maps/:slug/state?at= rejects a future timestamp", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/maps/lancaster/state?at=${new Date(Date.now() + 3_600_000).toISOString()}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_TIME_RANGE");
  });

  it("GET /api/v1/maps/:slug/events returns element-resolved deltas ordered by sequence", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from td_berth_event be")) {
        return {
          rows: [
            {
              ingestion_sequence: "100",
              event_at: new Date("2026-05-01T10:00:00Z"),
              message_type: "CC",
              td_area: "PX",
              from_berth: null,
              to_berth: "0512",
              description: "1S99",
            },
            {
              ingestion_sequence: "101",
              event_at: new Date("2026-05-01T10:01:00Z"),
              message_type: "CB",
              td_area: "PX",
              from_berth: "0512",
              to_berth: null,
              description: null,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/maps/lancaster/events?from=2026-05-01T10:00:00Z&to=2026-05-01T10:05:00Z",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.events).toEqual([
      {
        type: "berth.updated",
        sequence: 100,
        eventAt: "2026-05-01T10:00:00.000Z",
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
        description: "1S99",
        enteredAt: "2026-05-01T10:00:00.000Z",
      },
      {
        type: "berth.cleared",
        sequence: 101,
        eventAt: "2026-05-01T10:01:00.000Z",
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
      },
    ]);
    expect(body.nextCursor).toBeNull();
  });
});
