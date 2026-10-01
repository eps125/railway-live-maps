import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerPlaceRoutes } from "./places.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

function fakePool(handler: QueryHandler): Pool {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values),
  } as unknown as Pool;
}

describe("place routes", () => {
  it("GET /api/v1/places/search returns 400 when q is missing or blank", async () => {
    const pool = fakePool(() => {
      throw new Error("should not query when q is missing");
    });
    const app = Fastify();
    await registerPlaceRoutes(app, { pool });

    const missing = await app.inject({ method: "GET", url: "/api/v1/places/search" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("VALIDATION_ERROR");

    const blank = await app.inject({ method: "GET", url: "/api/v1/places/search?q=%20" });
    expect(blank.statusCode).toBe(400);
  });

  it("returns every covering map, and an empty list for an inert (no-map) result", async () => {
    const pool = fakePool((text, values) => {
      expect(text).toContain("from location_reference lr");
      // A guest sees public maps only — no extra parameter for the visibility predicate.
      expect(text).toContain("m.visibility = 'public'");
      expect(values).toEqual(["%lancaster%", 20]);
      return {
        rows: [
          {
            tiploc: "LANCSTR",
            stanox: "12345",
            crs: "LAN",
            name: "Lancaster",
            maps: [
              { slug: "lancaster", name: "Lancaster", elementId: "station-1" },
              { slug: "wcml-north", name: "WCML North", elementId: "station-9" },
            ],
          },
          {
            tiploc: "BAYHORS",
            stanox: null,
            crs: null,
            name: "Bay Horse Jn (Lancaster area)",
            maps: null,
          },
        ],
      };
    });
    const app = Fastify();
    await registerPlaceRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/places/search?q=lancaster" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        {
          tiploc: "LANCSTR",
          stanox: "12345",
          crs: "LAN",
          name: "Lancaster",
          maps: [
            { slug: "lancaster", name: "Lancaster", elementId: "station-1" },
            { slug: "wcml-north", name: "WCML North", elementId: "station-9" },
          ],
        },
        {
          tiploc: "BAYHORS",
          stanox: null,
          crs: null,
          name: "Bay Horse Jn (Lancaster area)",
          maps: [],
        },
      ],
    });
  });

  it("clamps limit to the maximum and falls back to the default for a non-positive value", async () => {
    const calls: unknown[][] = [];
    const pool = fakePool((_text, values) => {
      calls.push(values ?? []);
      return { rows: [] };
    });
    const app = Fastify();
    await registerPlaceRoutes(app, { pool });

    await app.inject({ method: "GET", url: "/api/v1/places/search?q=x&limit=9999" });
    await app.inject({ method: "GET", url: "/api/v1/places/search?q=x&limit=-5" });

    expect(calls[0]?.[1]).toBe(50);
    expect(calls[1]?.[1]).toBe(20);
  });
});
