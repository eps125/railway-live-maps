import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerCreateMapRoute } from "./createMap.js";
import { registerEditorDraftRoutes } from "./drafts.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueSlug(): string {
  return `test-map-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function buildApp() {
  const app = Fastify();
  await registerCreateMapRoute(app, { pool });
  await registerEditorDraftRoutes(app, { pool });
  await app.ready();
  return app;
}

/**
 * Milestone 30: role gating itself ("only an admin session reaches this handler at all") is
 * covered end to end in `apps/api/src/server.integration.test.ts`, matching
 * `routes/admin/users.integration.test.ts`'s split — this file is about the route's own behavior
 * once inside.
 */
describe("create map route (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("creates a map row and seeds a blank draft named after it", async () => {
    const app = await buildApp();
    const slug = uniqueSlug();

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      payload: { slug, name: "Test Map" },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.slug).toBe(slug);
    expect(created.name).toBe("Test Map");
    expect(created.draftRevision).toBe(1);

    const mapRow = await pool.query<{ id: string; slug: string; name: string }>(
      `select id, slug, name from map where slug = $1`,
      [slug],
    );
    expect(mapRow.rows[0]).toEqual({ id: created.mapId, slug, name: "Test Map" });

    const draftResponse = await app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${slug}/draft`,
    });
    expect(draftResponse.statusCode).toBe(200);
    const draft = draftResponse.json();
    expect(draft.mapId).toBe(created.mapId);
    expect(draft.canonicalDocument.map.name).toBe("Test Map");
    expect(draft.canonicalDocument.elements).toEqual([]);

    await app.close();
  });

  it("rejects an invalid slug with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      payload: { slug: "Not A Valid Slug!", name: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("rejects a missing name with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      payload: { slug: uniqueSlug() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("rejects a duplicate slug with 409, leaving the original map untouched", async () => {
    const app = await buildApp();
    const slug = uniqueSlug();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      payload: { slug, name: "Original Name" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      payload: { slug, name: "Different Name" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("DUPLICATE_SLUG");

    const mapRow = await pool.query(`select name from map where slug = $1`, [slug]);
    expect(mapRow.rows[0]!.name).toBe("Original Name");

    await app.close();
  });
});
