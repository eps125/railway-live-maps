import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerPlaceRoutes } from "./places.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

/** A random 3-uppercase-letter CRS — a fixed literal here once collided with an unrelated
 * integration test file's own fixed-literal CRS sharing the same live CI test database (both
 * suites run against the same Postgres within one CI job), making this test's search join onto
 * the wrong map. Never hardcode an identifier literal in an integration test again. */
function randomCrs(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join(
    "",
  );
}

async function seedLocation(overrides: {
  tiploc: string;
  stanox?: string;
  crs?: string;
  name: string;
}): Promise<void> {
  await pool.query(
    `insert into location_reference (tiploc, stanox, crs, name, raw_source_json)
     values ($1, $2, $3, $4, '{}')`,
    [overrides.tiploc, overrides.stanox ?? null, overrides.crs ?? null, overrides.name],
  );
}

/** Publishes a minimal map_version carrying one map_place_index row for the given tiploc,
 * mirroring liveMap.integration.test.ts's publishMinimalMap helper. `effectiveTo` lets a test
 * create a superseded (no-longer-effective) version. */
async function publishMapWithPlace(
  slug: string,
  elementId: string,
  tiploc: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
): Promise<{ mapVersionId: string }> {
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $2) on conflict (slug) do update set slug = excluded.slug returning id`,
    [slug, slug],
  );
  const mapId = mapResult.rows[0]!.id;

  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, effective_to, published_by, schema_version, checksum
     ) values ($1, (select coalesce(max(version_number), 0) + 1 from map_version where map_id = $1),
               '{}', '{}', $2, $3, 'test', 1, $4)
     returning id`,
    [mapId, effectiveFrom, effectiveTo, randomUUID()],
  );
  const mapVersionId = versionResult.rows[0]!.id;

  await pool.query(
    `insert into map_place_index (map_version_id, element_id, element_type, tiploc)
     values ($1, $2, 'station', $3)`,
    [mapVersionId, elementId, tiploc],
  );

  return { mapVersionId };
}

async function buildApp() {
  const app = Fastify();
  await registerPlaceRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("place routes (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("finds a location by partial name and reports its currently-effective covering map", async () => {
    const tiploc = uniqueCode("T");
    const crs = randomCrs();
    const name = `Test Junction ${uniqueCode("N")}`;
    await seedLocation({ tiploc, crs, name });
    const slug = `test-place-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await publishMapWithPlace(slug, "station-1", tiploc, new Date(0), null);

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/places/search?q=${encodeURIComponent(name.slice(0, 8))}`,
    });
    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<Record<string, unknown>>;
    const match = results.find((r) => r.tiploc === tiploc);
    expect(match).toEqual({
      tiploc,
      stanox: null,
      crs,
      name,
      mapSlug: slug,
      elementId: "station-1",
    });
    await app.close();
  });

  it("reports no covering map for a location nothing currently binds", async () => {
    const tiploc = uniqueCode("U");
    const name = `Unbound Place ${uniqueCode("N")}`;
    await seedLocation({ tiploc, name });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/places/search?q=${encodeURIComponent(name.slice(0, 8))}`,
    });
    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<Record<string, unknown>>;
    const match = results.find((r) => r.tiploc === tiploc);
    expect(match).toEqual({
      tiploc,
      stanox: null,
      crs: null,
      name,
      mapSlug: null,
      elementId: null,
    });
    await app.close();
  });

  it("ignores a map_place_index row belonging to a superseded (no-longer-effective) version", async () => {
    const tiploc = uniqueCode("V");
    const name = `Superseded Place ${uniqueCode("N")}`;
    await seedLocation({ tiploc, name });
    const slug = `test-place-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const now = new Date();
    await publishMapWithPlace(
      slug,
      "station-old",
      tiploc,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 30_000),
    );

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/places/search?q=${encodeURIComponent(name.slice(0, 8))}`,
    });
    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<Record<string, unknown>>;
    const match = results.find((r) => r.tiploc === tiploc);
    expect(match?.mapSlug).toBeNull();
    expect(match?.elementId).toBeNull();
    await app.close();
  });

  it("400s when q is missing", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/places/search" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
