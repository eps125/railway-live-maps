import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerCreateMapRoute } from "./createMap.js";
import { registerManageMapRoutes } from "./manageMap.js";
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
  await registerManageMapRoutes(app, { pool });
  await registerEditorDraftRoutes(app, { pool });
  await app.ready();
  return app;
}

async function createMap(app: ReturnType<typeof Fastify>, slug: string, name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/editor/maps",
    payload: { slug, name },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

/**
 * Owner request (2026-09-13): rename a map's name/slug, or delete it. Role gating itself is
 * covered end to end elsewhere (matching `createMap.integration.test.ts`'s split) — this file is
 * about the routes' own behavior once inside.
 */
describe("manage map routes (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("renames a map's name only, leaving its slug and draft slug untouched", async () => {
    const app = await buildApp();
    const slug = uniqueSlug();
    await createMap(app, slug, "Original Name");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${slug}`,
      payload: { name: "New Name" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ slug, name: "New Name" });

    const mapRow = await pool.query(`select slug, name from map where slug = $1`, [slug]);
    expect(mapRow.rows[0]).toEqual({ slug, name: "New Name" });

    const draft = await pool.query(
      `select slug, canonical_document from map_draft where slug = $1`,
      [slug],
    );
    expect(draft.rows[0]!.slug).toBe(slug);
    expect(draft.rows[0]!.canonical_document.map.name).toBe("New Name");
    expect(draft.rows[0]!.canonical_document.map.id).toBe(slug);

    await app.close();
  });

  it("renames a map's slug, keeping the draft's slug and canonical_document.map.id in sync", async () => {
    const app = await buildApp();
    const oldSlug = uniqueSlug();
    const newSlug = uniqueSlug();
    await createMap(app, oldSlug, "Movable Map");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${oldSlug}`,
      payload: { slug: newSlug },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ slug: newSlug, name: "Movable Map" });

    const oldRow = await pool.query(`select slug from map where slug = $1`, [oldSlug]);
    expect(oldRow.rows).toHaveLength(0);
    const newRow = await pool.query(`select slug, name from map where slug = $1`, [newSlug]);
    expect(newRow.rows[0]).toEqual({ slug: newSlug, name: "Movable Map" });

    const draft = await pool.query(
      `select slug, canonical_document from map_draft where slug = $1`,
      [newSlug],
    );
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]!.canonical_document.map.id).toBe(newSlug);
    // Still fetchable at the new slug through the ordinary draft route.
    const draftResponse = await app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${newSlug}/draft`,
    });
    expect(draftResponse.statusCode).toBe(200);

    await app.close();
  });

  it("rejects renaming to a slug already in use, leaving the original untouched", async () => {
    const app = await buildApp();
    const slugA = uniqueSlug();
    const slugB = uniqueSlug();
    await createMap(app, slugA, "Map A");
    await createMap(app, slugB, "Map B");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${slugA}`,
      payload: { slug: slugB },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DUPLICATE_SLUG");

    const mapRow = await pool.query(`select slug from map where slug = $1`, [slugA]);
    expect(mapRow.rows[0]!.slug).toBe(slugA);

    await app.close();
  });

  it("404s renaming a map that doesn't exist", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${uniqueSlug()}`,
      payload: { name: "Doesn't matter" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MAP_NOT_FOUND");
    await app.close();
  });

  it("rejects a body with neither name nor slug", async () => {
    const app = await buildApp();
    const slug = uniqueSlug();
    await createMap(app, slug, "Untouched");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${slug}`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("deletes a map along with its draft and draft revisions", async () => {
    const app = await buildApp();
    const slug = uniqueSlug();
    await createMap(app, slug, "Doomed Map");

    // Generate a draft revision row via a real save, so the delete has something to cascade.
    const draftResponse = await app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${slug}/draft`,
    });
    const draft = draftResponse.json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/editor/maps/${slug}/draft`,
      payload: { canonicalDocument: draft.canonicalDocument, expectedRevision: draft.revision },
    });

    const response = await app.inject({ method: "DELETE", url: `/api/v1/editor/maps/${slug}` });
    expect(response.statusCode).toBe(204);

    const mapRow = await pool.query(`select id from map where slug = $1`, [slug]);
    expect(mapRow.rows).toHaveLength(0);
    const draftRow = await pool.query(`select id from map_draft where slug = $1`, [slug]);
    expect(draftRow.rows).toHaveLength(0);

    await app.close();
  });

  it("never touches nationwide TD event tables when deleting a map (CLAUDE.md rule 17)", async () => {
    const app = await buildApp();
    const slug = uniqueSlug();
    await createMap(app, slug, "Isolated Map");

    const before = await pool.query(`select count(*)::int as n from td_berth_event`);

    const response = await app.inject({ method: "DELETE", url: `/api/v1/editor/maps/${slug}` });
    expect(response.statusCode).toBe(204);

    const after = await pool.query(`select count(*)::int as n from td_berth_event`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    await app.close();
  });

  it("404s deleting a map that doesn't exist", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/editor/maps/${uniqueSlug()}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MAP_NOT_FOUND");
    await app.close();
  });
});
