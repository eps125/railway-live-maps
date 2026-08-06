import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerEditorDiffRoutes } from "./diff.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueSlug(): string {
  return `test-diff-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function docWithElements(elementIds: string[]) {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", order: 0 }],
    elements: elementIds.map((id) => ({
      id,
      layerId: "l",
      type: "label",
      x: 0,
      y: 0,
      text: id,
      align: "left",
      fontSize: 12,
    })),
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

/** A realistic-shaped (if minimal) bundle — matters because /api/v1/maps lists every
 * currently-effective map_version across the whole test DB, so a bare `{}` placeholder here
 * would crash that unrelated endpoint for every other test in the same run. */
function minimalBundle(mapId: string) {
  return {
    schemaVersion: 1,
    mapId,
    mapName: mapId,
    canvas: { width: 100, height: 100, gridSize: 10 },
    timezone: "Europe/London",
    layers: [],
    elementsById: {},
    berthBindingIndex: {},
    sBitBindingIndex: {},
    boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    topologyAdjacency: {},
    continuationLinks: [],
  };
}

async function publishVersion(slug: string, elementIds: string[]): Promise<void> {
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $2) returning id`,
    [slug, slug],
  );
  await pool.query(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, $2, $3, now(), 'test', 1, 'test-checksum')`,
    [
      mapResult.rows[0]!.id,
      JSON.stringify(docWithElements(elementIds)),
      JSON.stringify(minimalBundle(slug)),
    ],
  );
}

async function seedDraft(slug: string, elementIds: string[]): Promise<void> {
  await pool.query(
    `insert into map_draft (slug, canonical_document, revision) values ($1, $2, 1)`,
    [slug, JSON.stringify(docWithElements(elementIds))],
  );
}

async function buildApp() {
  const app = Fastify();
  await registerEditorDiffRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("GET /api/v1/editor/maps/:slug/diff (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("diffs the current draft against the currently published version by default", async () => {
    const slug = uniqueSlug();
    await publishVersion(slug, ["kept", "removed-in-draft"]);
    await seedDraft(slug, ["kept", "added-in-draft"]);

    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/diff` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.elements.added).toEqual(["added-in-draft"]);
      expect(body.elements.removed).toEqual(["removed-in-draft"]);
      expect(body.elements.modified).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("404s when no published version exists to compare against", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, ["a"]);
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/diff` });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("MAP_VERSION_NOT_FOUND");
    } finally {
      await app.close();
    }
  });
});
