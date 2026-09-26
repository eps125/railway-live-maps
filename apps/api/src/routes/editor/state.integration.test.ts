import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerEditorStateRoutes } from "./state.js";
import { recordObservedBerthEvent } from "../../testSupport/tdEvents.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueSlug(): string {
  return `test-state-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function seedDraft(slug: string, tdArea: string, berth: string): Promise<void> {
  const doc = {
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
    bindings: [{ id: "bind-a", elementId: "berth-a", type: "tdBerth", tdArea, berth }],
    editorMetadata: {},
  };
  await pool.query(
    `insert into map_draft (slug, canonical_document, revision) values ($1, $2, 1)`,
    [slug, JSON.stringify(doc)],
  );
}

async function buildApp() {
  const app = Fastify();
  await registerEditorStateRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("GET /api/v1/editor/state/:slug (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("computes current live state for the draft's own bindings", async () => {
    const slug = uniqueSlug();
    const area = uniqueArea();
    await seedDraft(slug, area, "0001");
    await recordObservedBerthEvent(pool, area, null, "0001", "1A23");

    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/editor/state/${slug}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mode).toBe("live");
      expect(body.berths["berth-a"]).toMatchObject({ description: "1A23" });
    } finally {
      await app.close();
    }
  });

  it("recompiles only when the draft's revision changes (2026-09-26 compile cache)", async () => {
    const slug = uniqueSlug();
    const area = uniqueArea();
    await seedDraft(slug, area, "0001");
    await recordObservedBerthEvent(pool, area, null, "0001", "1A23");
    await recordObservedBerthEvent(pool, area, null, "0002", "2B34");

    const app = await buildApp();
    try {
      const first = await app.inject({ method: "GET", url: `/api/v1/editor/state/${slug}` });
      expect(first.json()).toMatchObject({ draftRevision: 1 });
      expect(first.json().berths["berth-a"]).toMatchObject({ description: "1A23" });

      // Rebind the berth to 0002 as a new revision: the next poll must use the new bindings.
      await pool.query(
        `update map_draft
            set canonical_document = jsonb_set(canonical_document, '{bindings,0,berth}', '"0002"'),
                revision = 2
          where slug = $1`,
        [slug],
      );
      const second = await app.inject({ method: "GET", url: `/api/v1/editor/state/${slug}` });
      expect(second.json()).toMatchObject({ draftRevision: 2 });
      expect(second.json().berths["berth-a"]).toMatchObject({ description: "2B34" });

      // A document change without a revision bump is not how the editor saves; the cache keeps
      // the compile for revision 2 — proving the poll no longer recompiles an unchanged draft.
      await pool.query(
        `update map_draft
            set canonical_document = jsonb_set(canonical_document, '{bindings,0,berth}', '"0001"')
          where slug = $1`,
        [slug],
      );
      const third = await app.inject({ method: "GET", url: `/api/v1/editor/state/${slug}` });
      expect(third.json().berths["berth-a"]).toMatchObject({ description: "2B34" });
    } finally {
      await app.close();
    }
  });

  it("404s when no draft exists yet", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/editor/state/nonexistent-slug`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("DRAFT_NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("501s for a historical `at` far from now, pointing at Milestone 10", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, uniqueArea(), "0001");
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/editor/state/${slug}?at=2020-01-01T00:00:00Z`,
      });
      expect(response.statusCode).toBe(501);
      expect(response.json().error.code).toBe("NOT_YET_SUPPORTED");
    } finally {
      await app.close();
    }
  });
});
