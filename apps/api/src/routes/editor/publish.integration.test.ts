import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerEditorPublishRoutes } from "./publish.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueSlug(): string {
  return `test-publish-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function validDoc(slug: string, berth = "0001") {
  return {
    schemaVersion: 1,
    map: {
      id: slug,
      name: slug,
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", order: 0 }],
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
    ],
    topology: { nodes: [], edges: [] },
    bindings: [{ id: "bind-a", elementId: "berth-a", type: "tdBerth", tdArea: "ZZ", berth }],
    editorMetadata: {},
  };
}

function invalidDoc(slug: string) {
  return {
    schemaVersion: 1,
    map: {
      id: slug,
      name: slug,
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", order: 0 }],
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
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

async function seedDraft(slug: string, doc: unknown): Promise<void> {
  await pool.query(
    `insert into map_draft (slug, canonical_document, revision) values ($1, $2, 1)`,
    [slug, JSON.stringify(doc)],
  );
}

async function buildApp() {
  const app = Fastify();
  await registerEditorPublishRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("POST /api/v1/editor/maps/:slug/publish (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("happy path creates a map_version with matching map_binding_index rows", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, validDoc(slug));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/editor/maps/${slug}/publish`,
        payload: { expectedRevision: 1, publishedBy: "test" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.versionNumber).toBe(1);

      const bindings = await pool.query(
        `select element_id, td_area, berth from map_binding_index where map_version_id = $1`,
        [body.mapVersionId],
      );
      expect(bindings.rows).toEqual([{ element_id: "berth-a", td_area: "ZZ", berth: "0001" }]);
    } finally {
      await app.close();
    }
  });

  it("republishing closes the prior open version", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, validDoc(slug, "0001"));
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: `/api/v1/editor/maps/${slug}/publish`,
        payload: { expectedRevision: 1 },
      });
      const firstVersionId = first.json().mapVersionId;

      await pool.query(
        `update map_draft set canonical_document = $1, revision = 2 where slug = $2`,
        [JSON.stringify(validDoc(slug, "9999")), slug],
      );
      const second = await app.inject({
        method: "POST",
        url: `/api/v1/editor/maps/${slug}/publish`,
        payload: { expectedRevision: 2, effectiveFrom: new Date(Date.now() + 1000).toISOString() },
      });
      expect(second.statusCode).toBe(200);

      const firstVersion = await pool.query(`select effective_to from map_version where id = $1`, [
        firstVersionId,
      ]);
      expect(firstVersion.rows[0].effective_to).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("a publication-blocking validation error (unbound berth) prevents publish with 422", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, invalidDoc(slug));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/editor/maps/${slug}/publish`,
        payload: { expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");

      const versions = await pool.query(
        `select 1 from map_version mv join map m on m.id = mv.map_id where m.slug = $1`,
        [slug],
      );
      expect(versions.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a stale expectedRevision 409s instead of publishing", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, validDoc(slug));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/editor/maps/${slug}/publish`,
        payload: { expectedRevision: 99 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("DRAFT_REVISION_CONFLICT");

      const versions = await pool.query(
        `select 1 from map_version mv join map m on m.id = mv.map_id where m.slug = $1`,
        [slug],
      );
      expect(versions.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
