import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerEditorValidateRoutes } from "./validate.js";
import { recordObservedBerthEvent } from "../../testSupport/tdEvents.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function buildApp() {
  const app = Fastify();
  await registerEditorValidateRoutes(app, { pool });
  await app.ready();
  return app;
}

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
    ...overrides,
  };
}

describe("POST /api/v1/editor/maps/:slug/validate (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("blocks on a boundary element referencing an unknown adjacent map slug", async () => {
    const app = await buildApp();
    try {
      const doc = baseDoc({
        elements: [
          {
            id: "b1",
            layerId: "l",
            type: "boundary",
            x: 0,
            y: 0,
            name: "North",
            adjacentMapSlug: "totally-unknown-map",
          },
        ],
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/editor/maps/test/validate",
        payload: { canonicalDocument: doc },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.valid).toBe(false);
      expect(body.errors.some((e: { code: string }) => e.code === "unknown_adjacent_map")).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("warns when a td berth binding has never been observed, and reports observed ones as valid", async () => {
    const app = await buildApp();
    try {
      const observedArea = uniqueArea();
      const unobservedArea = uniqueArea();
      await recordObservedBerthEvent(pool, observedArea, null, "0001", "1A23");

      const doc = baseDoc({
        elements: [
          {
            id: "berth-a",
            layerId: "l",
            type: "berth",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            displayName: "A",
            bindingId: "bind-a",
          },
          {
            id: "berth-b",
            layerId: "l",
            type: "berth",
            x: 20,
            y: 0,
            width: 10,
            height: 10,
            displayName: "B",
            bindingId: "bind-b",
          },
        ],
        bindings: [
          {
            id: "bind-a",
            elementId: "berth-a",
            type: "tdBerth",
            tdArea: observedArea,
            berth: "0001",
          },
          {
            id: "bind-b",
            elementId: "berth-b",
            type: "tdBerth",
            tdArea: unobservedArea,
            berth: "9999",
          },
        ],
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/editor/maps/test/validate",
        payload: { canonicalDocument: doc },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.valid).toBe(true);
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0].bindingId).toBe("bind-b");
      expect(body.info.observedBerthBindingPercentage).toBe(50);
      expect(body.info.boundBerthCount).toBe(2);
      expect(body.info.unboundBerthCount).toBe(0);
      expect(body.info.elementCounts.berth).toBe(2);
    } finally {
      await app.close();
    }
  });
});
