import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, createUser } from "@railway/database";
import type { MapDocument } from "@railway/map-schema";
import { buildServer } from "./server.js";
import type { Config } from "./config.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

function testConfig(): Config {
  return {
    APP_ENV: "test",
    PORT: 0,
    DATABASE_URL: requireEnv("DATABASE_URL"),
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    DISPLAY_TIMEZONE: "Europe/London",
    SESSION_TTL_SECONDS: 3600,
    COOKIE_SECURE: false,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: 50,
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: 900,
    LIVE_WS_REDIS_PUBSUB_ENABLED: false,
    LIVE_WS_POLL_INTERVAL_MS: 1000,
    LIVE_WS_HEARTBEAT_INTERVAL_MS: 15000,
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
const PASSWORD = "correct-horse-battery";
type App = Awaited<ReturnType<typeof buildServer>>["app"];
let app: App;
let close: () => Promise<void>;
let cookie: string;

const LAYERS = [{ id: "layer-track", name: "Track", visible: true, locked: false, order: 0 }];

/** A module: two tracks 200 long (y=0 and y=30), with West/East joins, and a label. Berths are
 * left out so the test needs no TD data. */
function moduleDoc(slug: string, length = 200): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: slug,
      name: slug,
      canvas: { width: 400, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: LAYERS,
    elements: [
      {
        id: "up",
        type: "trackPath",
        layerId: "layer-track",
        zIndex: 0,
        points: [
          { x: 0, y: 0 },
          { x: length, y: 0 },
        ],
      },
      {
        id: "down",
        type: "trackPath",
        layerId: "layer-track",
        zIndex: 0,
        points: [
          { x: 0, y: 30 },
          { x: length, y: 30 },
        ],
      },
      {
        id: "name",
        type: "label",
        layerId: "layer-track",
        zIndex: 0,
        x: 20,
        y: -20,
        text: slug,
        align: "center",
        fontSize: 12,
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
    joins: [
      {
        id: "west",
        name: "West",
        points: [
          { x: 0, y: -10 },
          { x: 0, y: 40 },
        ],
      },
      {
        id: "east",
        name: "East",
        points: [
          { x: length, y: -10 },
          { x: length, y: 40 },
        ],
      },
    ],
  } as MapDocument;
}

async function create(slug: string, kind: "map" | "module"): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/editor/maps",
    headers: { cookie },
    payload: { slug, name: slug, kind },
  });
  expect(response.statusCode).toBe(201);
}

async function saveDraft(slug: string, doc: MapDocument): Promise<number> {
  const current = await app.inject({
    method: "GET",
    url: `/api/v1/editor/maps/${slug}/draft`,
    headers: { cookie },
  });
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/editor/maps/${slug}/draft`,
    headers: { cookie },
    payload: { canonicalDocument: doc, expectedRevision: current.json().revision },
  });
  expect(response.statusCode).toBe(200);
  return response.json().revision as number;
}

async function publish(slug: string, expectedRevision: number) {
  return app.inject({
    method: "POST",
    url: `/api/v1/editor/maps/${slug}/publish`,
    headers: { cookie },
    payload: { expectedRevision },
  });
}

async function definition(slug: string) {
  const response = await app.inject({ method: "GET", url: `/api/v1/maps/${slug}/definition` });
  return response;
}

const west = `west-${suffix}`;
const east = `east-${suffix}`;
const assembled = `assembled-${suffix}`;

/**
 * Milestone 85 (docs/adr/0019): modules end to end through the real server — publishing a module
 * (never public on its own), assembling a map from modules attached by joins, a module change
 * republishing every map assembled from it, making a module from a selection, the delete guard and
 * republish-all.
 */
describe("map modules (integration)", () => {
  beforeAll(async () => {
    const built = await buildServer(testConfig());
    app = built.app;
    close = built.close;
    const admin = `modules-admin-${suffix}`;
    await createUser(pool, { username: admin, password: PASSWORD, role: "admin" });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: admin, password: PASSWORD },
    });
    const setCookie = login.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(";")[0]!;
  });

  afterAll(async () => {
    await close();
    await pool.end();
  });

  it("publishes modules as module versions, never as public maps", async () => {
    await create(west, "module");
    await create(east, "module");
    const westPublish = await publish(west, await saveDraft(west, moduleDoc(west)));
    expect(westPublish.statusCode).toBe(200);
    expect(westPublish.json()).toMatchObject({ kind: "module", versionNumber: 1, cascade: [] });
    expect((await publish(east, await saveDraft(east, moduleDoc(east)))).statusCode).toBe(200);

    expect((await definition(west)).statusCode).toBe(404);
    const list = (await app.inject({ method: "GET", url: "/api/v1/maps" })).json();
    expect(list.maps.some((m: { slug: string }) => m.slug === west)).toBe(false);
  });

  it("publishes an assembled map: flattened, attached by joins, with its source kept", async () => {
    await create(assembled, "map");
    const source = {
      ...moduleDoc(assembled),
      elements: [],
      joins: undefined,
      modules: [
        { slug: west, placement: { kind: "at", x: 100, y: 100 } },
        { slug: east, placement: { kind: "attached", join: "west", to: west, toJoin: "east" } },
      ],
    } as unknown as MapDocument;
    const revision = await saveDraft(assembled, source);

    const validate = await app.inject({
      method: "POST",
      url: `/api/v1/editor/maps/${assembled}/validate`,
      headers: { cookie },
      payload: { canonicalDocument: source },
    });
    expect(validate.json().valid).toBe(true);

    const published = await publish(assembled, revision);
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ kind: "map", versionNumber: 1 });

    const bundle = (await definition(assembled)).json().definition;
    expect(bundle.elementsById[`${east}/up`].points).toEqual([
      { x: 300, y: 100 },
      { x: 500, y: 100 },
    ]);
    expect(bundle.elementsById[`${west}/up`].points[0]).toEqual({ x: 100, y: 100 });

    const row = await pool.query<{ source_document: MapDocument; module_versions: unknown }>(
      `select mv.source_document, mv.module_versions from map_version mv join map m on m.id = mv.map_id
        where m.slug = $1 and mv.effective_to is null`,
      [assembled],
    );
    expect(row.rows[0]!.source_document.modules).toHaveLength(2);
    expect(row.rows[0]!.module_versions).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: west, versionNumber: 1 })]),
    );
  });

  it("publishing a changed module republishes the map, moving everything attached beyond it", async () => {
    const revision = await saveDraft(west, moduleDoc(west, 260));
    const published = await publish(west, revision);
    expect(published.json().cascade).toEqual([{ slug: assembled, ok: true, versionNumber: 2 }]);

    const bundle = (await definition(assembled)).json().definition;
    expect(bundle.elementsById[`${east}/up`].points[0]).toEqual({ x: 360, y: 100 });

    // The assembled map's draft is still its source, not the flattened document.
    const draft = await app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${assembled}/draft`,
      headers: { cookie },
    });
    expect(draft.json().canonicalDocument.modules).toHaveLength(2);
  });

  it("a module change that breaks a join leaves the map as it was, and says why", async () => {
    const broken = moduleDoc(west, 260);
    broken.elements = broken.elements.filter((e) => e.id !== "down");
    const published = await publish(west, await saveDraft(west, broken));
    expect(published.statusCode).toBe(200);
    expect(published.json().cascade[0]).toMatchObject({ slug: assembled, ok: false });
    expect(published.json().cascade[0].errors[0].code).toBe("join_track_count_mismatch");
    // Restore.
    await publish(west, await saveDraft(west, moduleDoc(west, 260)));
  });

  it("an assembled map can't publish with a module that was never published", async () => {
    const unpublished = `unpublished-${suffix}`;
    await create(unpublished, "module");
    const current = (
      await app.inject({
        method: "GET",
        url: `/api/v1/editor/maps/${assembled}/draft`,
        headers: { cookie },
      })
    ).json().canonicalDocument as MapDocument;
    const revision = await saveDraft(assembled, {
      ...current,
      modules: [
        ...current.modules!,
        { slug: unpublished, placement: { kind: "at", x: 0, y: 500 } },
      ],
    });
    const response = await publish(assembled, revision);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.errors[0].code).toBe("module_missing");
    await saveDraft(assembled, current);
  });

  it("won't delete a module a map still uses", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/editor/maps/${east}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MODULE_IN_USE");
  });

  it("lists modules with the maps using them", async () => {
    const list = (
      await app.inject({ method: "GET", url: "/api/v1/editor/maps", headers: { cookie } })
    ).json();
    expect(list.maps.find((m: { slug: string }) => m.slug === east)).toMatchObject({
      kind: "module",
      usedBy: [assembled],
      publishedVersion: 1,
    });
    const modules = (
      await app.inject({
        method: "GET",
        url: `/api/v1/editor/modules?slugs=${west},${east}`,
        headers: { cookie },
      })
    ).json().modules;
    expect(modules).toHaveLength(2);
    expect(modules.find((m: { slug: string }) => m.slug === west).publishedVersion).toBe(4);
  });

  it("makes a module from a selection without moving anything", async () => {
    const plain = `plain-${suffix}`;
    const carved = `carved-${suffix}`;
    await create(plain, "map");
    const doc = moduleDoc(plain);
    delete doc.joins;
    const revision = await saveDraft(plain, doc);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/editor/maps/${plain}/extract-module`,
      headers: { cookie },
      payload: {
        elementIds: ["up", "down"],
        moduleSlug: carved,
        moduleName: "Carved",
        expectedRevision: revision,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ moduleSlug: carved, movedElements: 2, keptInMap: [] });
    const remaining = response.json().canonicalDocument as MapDocument;
    expect(remaining.elements.map((e) => e.id)).toEqual(["name"]);
    expect(remaining.modules).toEqual([{ slug: carved, placement: { kind: "at", x: 0, y: 0 } }]);

    const moduleDraft = (
      await app.inject({
        method: "GET",
        url: `/api/v1/editor/maps/${carved}/draft`,
        headers: { cookie },
      })
    ).json();
    expect(moduleDraft.canonicalDocument.elements).toHaveLength(2);

    // Publish the module, then the map: the same tracks, now from the module.
    await publish(carved, moduleDraft.revision);
    const mapPublish = await publish(plain, response.json().revision);
    expect(mapPublish.statusCode).toBe(200);
    const bundle = (await definition(plain)).json().definition;
    expect(bundle.elementsById[`${carved}/up`].points).toEqual(
      doc.elements[0]!.type === "trackPath" ? doc.elements[0]!.points : [],
    );
  });

  it("republishes every map on request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/maps/republish-all",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const mine = response
      .json()
      .maps.filter((m: { slug: string }) => m.slug === assembled || m.slug === `plain-${suffix}`);
    expect(mine).toHaveLength(2);
    expect(mine.every((m: { ok: boolean }) => m.ok)).toBe(true);
  });
});
