import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerMapRoutes } from "./maps.js";

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

describe("map routes", () => {
  it("GET /api/v1/maps lists published maps with live-data status", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_version mv")) return { rows: [mapVersionRow()] };
      if (text.includes("from td_heartbeat")) {
        return { rows: [{ last_heartbeat_at: new Date() }] };
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
              occupancy_entered_at: new Date("2026-08-04T12:00:00Z"),
              source_ingestion_sequence: "42",
            },
          ],
        };
      }
      if (text.includes("from td_heartbeat")) return { rows: [{ last_heartbeat_at: new Date() }] };
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/maps/lancaster/state" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.berths["berth-1"]).toEqual({
      description: "2A16",
      enteredAt: "2026-08-04T12:00:00.000Z",
      runSummary: null,
    });
    expect(body.signals["signal-1"]).toEqual({ state: "blank" });
    expect(body.sourceSequence).toBe(42);
  });

  it("GET /api/v1/maps/:slug/state rejects a historical `at` with NOT_YET_SUPPORTED", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const app = Fastify();
    await registerMapRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/maps/lancaster/state?at=2020-01-01T00:00:00Z",
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("NOT_YET_SUPPORTED");
  });
});
