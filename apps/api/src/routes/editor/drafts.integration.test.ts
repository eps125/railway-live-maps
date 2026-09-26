import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { GZIP_DRAFT_CONTENT_TYPE, registerEditorDraftRoutes } from "./drafts.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueSlug(): string {
  return `test-draft-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function minimalDoc(mapId: string) {
  return {
    schemaVersion: 1,
    map: {
      id: mapId,
      name: mapId,
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

async function buildApp() {
  const app = Fastify();
  await registerEditorDraftRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("editor draft routes (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("GET seeds a fresh blank draft (revision 1) for a never-before-drafted slug", async () => {
    const slug = uniqueSlug();
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/editor/maps/${slug}/draft`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.slug).toBe(slug);
      expect(body.revision).toBe(1);
      expect(body.canonicalDocument.elements).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET seeds a blank draft named after a pre-existing, never-published map row (Milestone 30)", async () => {
    const slug = uniqueSlug();
    await pool.query(`insert into map (slug, name) values ($1, $2)`, [slug, "Pre-created Map"]);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/editor/maps/${slug}/draft`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mapId).not.toBeNull();
      expect(body.canonicalDocument.map.name).toBe("Pre-created Map");
    } finally {
      await app.close();
    }
  });

  it("PUT with the correct expectedRevision succeeds, bumps revision, and records a revision row", async () => {
    const slug = uniqueSlug();
    const app = await buildApp();
    try {
      await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/draft` });

      const putResponse = await app.inject({
        method: "PUT",
        url: `/api/v1/editor/maps/${slug}/draft`,
        payload: {
          canonicalDocument: minimalDoc(slug),
          expectedRevision: 1,
          updatedBy: "test-user",
        },
      });
      expect(putResponse.statusCode).toBe(200);
      const body = putResponse.json();
      expect(body.revision).toBe(2);
      expect(body.updatedBy).toBe("test-user");

      const revisionsResponse = await app.inject({
        method: "GET",
        url: `/api/v1/editor/maps/${slug}/revisions`,
      });
      expect(revisionsResponse.statusCode).toBe(200);
      const revisions = revisionsResponse.json().revisions;
      expect(revisions).toHaveLength(1);
      expect(revisions[0].revision).toBe(2);
      expect(revisions[0].author).toBe("test-user");
    } finally {
      await app.close();
    }
  });

  it("PUT with a stale expectedRevision returns 409 with the current revision, and does not apply the change", async () => {
    const slug = uniqueSlug();
    const app = await buildApp();
    try {
      await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/draft` });
      await app.inject({
        method: "PUT",
        url: `/api/v1/editor/maps/${slug}/draft`,
        payload: { canonicalDocument: minimalDoc(slug), expectedRevision: 1 },
      });

      const staleResponse = await app.inject({
        method: "PUT",
        url: `/api/v1/editor/maps/${slug}/draft`,
        payload: { canonicalDocument: minimalDoc(slug), expectedRevision: 1 },
      });
      expect(staleResponse.statusCode).toBe(409);
      const body = staleResponse.json();
      expect(body.error.code).toBe("DRAFT_REVISION_CONFLICT");
      expect(body.error.details.currentRevision).toBe(2);

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/v1/editor/maps/${slug}/draft`,
      });
      expect(getResponse.json().revision).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("PUT rejects a body that doesn't parse as a MapDocument", async () => {
    const slug = uniqueSlug();
    const app = await buildApp();
    try {
      await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/draft` });
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/editor/maps/${slug}/draft`,
        payload: { canonicalDocument: { not: "a valid document" }, expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("PUT accepts a gzipped draft (2026-09-26), stores the same document, and records the revision", async () => {
    const slug = uniqueSlug();
    const app = await buildApp();
    try {
      await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/draft` });
      const doc = { ...minimalDoc(slug), editorMetadata: { note: "gzipped" } };
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/editor/maps/${slug}/draft`,
        headers: { "content-type": GZIP_DRAFT_CONTENT_TYPE },
        payload: gzipSync(JSON.stringify({ canonicalDocument: doc, expectedRevision: 1 })),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().revision).toBe(2);
      expect(response.json().canonicalDocument.editorMetadata).toEqual({ note: "gzipped" });

      const stored = await pool.query<{ canonical_document: { editorMetadata: unknown } }>(
        "select canonical_document from map_draft where slug = $1",
        [slug],
      );
      expect(stored.rows[0]!.canonical_document.editorMetadata).toEqual({ note: "gzipped" });
      const revision = await pool.query<{ canonical_document: { editorMetadata: unknown } }>(
        `select r.canonical_document from map_draft_revision r
           join map_draft d on d.id = r.map_draft_id
          where d.slug = $1 and r.revision = 2`,
        [slug],
      );
      expect(revision.rows[0]!.canonical_document.editorMetadata).toEqual({ note: "gzipped" });
    } finally {
      await app.close();
    }
  });

  it("PUT rejects a gzipped body that doesn't decompress, with 400 and no change", async () => {
    const slug = uniqueSlug();
    const app = await buildApp();
    try {
      await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/draft` });
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/editor/maps/${slug}/draft`,
        headers: { "content-type": GZIP_DRAFT_CONTENT_TYPE },
        payload: Buffer.from("definitely not gzip"),
      });
      expect(response.statusCode).toBe(400);
      const get = await app.inject({ method: "GET", url: `/api/v1/editor/maps/${slug}/draft` });
      expect(get.json().revision).toBe(1);
    } finally {
      await app.close();
    }
  });
});
