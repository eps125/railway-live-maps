import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import type { MapDocument } from "@railway/map-schema";
import { runRescaleMapDraft } from "./rescaleMapDraft.js";
import type { Config } from "../config.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

const testConfig: Config = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  REDIS_URL: "redis://localhost:6379",
  RAW_ARCHIVE_ENDPOINT: "http://localhost:9000",
  RAW_ARCHIVE_BUCKET: "unused-in-this-suite",
  RAW_ARCHIVE_ACCESS_KEY: "unused",
  RAW_ARCHIVE_SECRET_KEY: "unused",
  RAW_ARCHIVE_REGION: "us-east-1",
  CAPTURE_ALL_TD: "true",
  NR_TD_TOPIC: "/topic/TD_ALL_SIG_AREA",
  TD_LIVE_ENABLED: false,
  NR_CORPUS_DOWNLOAD_URL: "https://example.invalid/corpus",
  NR_SMART_DOWNLOAD_URL: "https://example.invalid/smart",
  SCHEDULE_DOWNLOAD_ENABLED: false,
  REFERENCE_DATA_REFRESH_TIME: "01:00",
  PARTITION_MONTHS_AHEAD: 3,
  GARNER_BRIDGE_ENABLED: false,
  GARNER_DB_HOST: "",
  GARNER_DB_PORT: 3306,
  GARNER_DB_NAME: "rail",
  GARNER_DB_USER: "",
  GARNER_DB_PASSWORD: "",
  GARNER_BRIDGE_BACKFILL_DAYS: 14,
  LIVE_WS_REDIS_PUBSUB_ENABLED: false,
  SNAPSHOT_INTERVAL_MS: 300_000,
  RUN_LINEAGE_FRESH_RESOLUTION_ENABLED: false,
  RUN_LINEAGE_FRESH_RESOLUTION_SCOPE: "mapped",
  NR_USERNAME: undefined,
  NR_PASSWORD: undefined,
};

function uniqueSlug(): string {
  return `test-rescale-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function minimalDoc(mapId: string): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: mapId,
      name: `Test map ${mapId}`,
      canvas: { width: 2000, height: 800, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "layer-track", name: "Track", visible: true, locked: false, order: 0 }],
    elements: [
      {
        id: "track-1",
        layerId: "layer-track",
        zIndex: 0,
        type: "trackPath",
        points: [
          { x: 0, y: 30 },
          { x: 100, y: 30 },
        ],
      },
      {
        id: "berth-1",
        layerId: "layer-track",
        zIndex: 0,
        type: "berth",
        x: 20,
        y: 20,
        width: 32,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "1008",
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

async function seedDraft(slug: string, doc: MapDocument): Promise<{ id: string }> {
  const result = await pool.query<{ id: string }>(
    `insert into map_draft (slug, canonical_document, revision) values ($1, $2, 1) returning id`,
    [slug, JSON.stringify(doc)],
  );
  return { id: result.rows[0]!.id };
}

async function currentDraft(
  slug: string,
): Promise<{ canonical_document: MapDocument; revision: number }> {
  const result = await pool.query<{ canonical_document: MapDocument; revision: number }>(
    `select canonical_document, revision from map_draft where slug = $1`,
    [slug],
  );
  return result.rows[0]!;
}

describe("runRescaleMapDraft (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("--scale multiplies coordinates, bumps revision and records a map_draft_revision snapshot", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, minimalDoc(slug));

    await runRescaleMapDraft(testConfig, ["--slug", slug, "--scale", "1.5"]);

    const draft = await currentDraft(slug);
    expect(draft.revision).toBe(2);
    expect(draft.canonical_document.map.canvas).toEqual({
      width: 3000,
      height: 1200,
      gridSize: 15,
    });
    const track = draft.canonical_document.elements[0];
    expect(track?.type).toBe("trackPath");
    if (track?.type === "trackPath") {
      expect(track.points).toEqual([
        { x: 0, y: 45 },
        { x: 150, y: 45 },
      ]);
    }
    const berth = draft.canonical_document.elements[1];
    expect(berth).toMatchObject({ x: 30, y: 30, width: 32, height: 20 });

    const revisionRow = await pool.query<{ revision: number; comment: string | null }>(
      `select revision, comment from map_draft_revision
       where map_draft_id = (select id from map_draft where slug = $1) and revision = 2`,
      [slug],
    );
    expect(revisionRow.rows[0]).toMatchObject({ revision: 2, comment: "x1.5 rescale" });
  });

  it("--dry-run reports what would happen without writing anything", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, minimalDoc(slug));

    await runRescaleMapDraft(testConfig, ["--slug", slug, "--scale", "1.5", "--dry-run"]);

    const draft = await currentDraft(slug);
    expect(draft.revision).toBe(1);
    expect(draft.canonical_document.map.canvas.gridSize).toBe(10);
  });

  it("--restore puts an exact prior snapshot back as a new revision, undoing a --scale", async () => {
    const slug = uniqueSlug();
    const original = minimalDoc(slug);
    await seedDraft(slug, original);

    await runRescaleMapDraft(testConfig, ["--slug", slug, "--scale", "1.5"]);
    let draft = await currentDraft(slug);
    expect(draft.revision).toBe(2);
    expect(draft.canonical_document.map.canvas.gridSize).toBe(15);

    await runRescaleMapDraft(testConfig, ["--slug", slug, "--restore", "1"]);
    draft = await currentDraft(slug);
    expect(draft.revision).toBe(3);
    expect(draft.canonical_document).toEqual(original);
  });

  it("errors without writing when --restore names a revision that doesn't exist", async () => {
    const slug = uniqueSlug();
    await seedDraft(slug, minimalDoc(slug));

    await runRescaleMapDraft(testConfig, ["--slug", slug, "--restore", "99"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // the command sets this like any CLI error exit — reset so it doesn't leak into the rest of this process's test run.

    const draft = await currentDraft(slug);
    expect(draft.revision).toBe(1);
  });

  it("errors without writing for a slug with no draft", async () => {
    await runRescaleMapDraft(testConfig, ["--slug", uniqueSlug(), "--scale", "1.5"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // see comment above
    // No further assertion — there's nothing to query for a slug that was never seeded.
  });
});
