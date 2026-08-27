import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { runPublishMap } from "./publishMap.js";
import type { Config } from "../config.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
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
  NR_VSTP_TOPIC: "/topic/VSTP_ALL",
  VSTP_LIVE_ENABLED: false,
  NR_TRUST_TOPIC: "/topic/TRAIN_MVT_ALL_TOC",
  TRUST_LIVE_ENABLED: false,
  NR_SCHEDULE_DOWNLOAD_URL: "https://example.invalid/schedule",
  NR_CORPUS_DOWNLOAD_URL: "https://example.invalid/corpus",
  NR_SMART_DOWNLOAD_URL: "https://example.invalid/smart",
  SCHEDULE_DOWNLOAD_ENABLED: false,
  REFERENCE_DATA_REFRESH_TIME: "01:00",
  PARTITION_MONTHS_AHEAD: 3,
  RESOLVER_LIVE_WINDOW_HOURS: 72,
  LIVE_WS_REDIS_PUBSUB_ENABLED: false,
  NR_USERNAME: undefined,
  NR_PASSWORD: undefined,
};

function uniqueSlug(): string {
  return `test-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Minimal two-berth map document, mirroring packages/map-schema/fixtures/lancaster-minimal.json
 * but with caller-supplied slug/area/berth so each test gets an isolated map. */
function minimalDoc(mapId: string, area1: string, berth1: string, area2: string, berth2: string) {
  return {
    schemaVersion: 1,
    map: {
      id: mapId,
      name: `Test map ${mapId}`,
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "layer-berths", name: "Berths", order: 0 }],
    elements: [
      {
        id: "berth-a",
        layerId: "layer-berths",
        type: "berth",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        displayName: "A",
        bindingId: "bind-a",
      },
      {
        id: "berth-b",
        layerId: "layer-berths",
        type: "berth",
        x: 20,
        y: 0,
        width: 10,
        height: 10,
        displayName: "B",
        bindingId: "bind-b",
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [
      { id: "bind-a", elementId: "berth-a", type: "tdBerth", tdArea: area1, berth: berth1 },
      { id: "bind-b", elementId: "berth-b", type: "tdBerth", tdArea: area2, berth: berth2 },
    ],
  };
}

interface BindingRow {
  element_id: string;
  binding_type: string;
  td_area: string;
  berth: string | null;
}

async function bindingsFor(mapVersionId: string): Promise<BindingRow[]> {
  const result = await pool.query<BindingRow>(
    `select element_id, binding_type, td_area, berth from map_binding_index
     where map_version_id = $1 order by element_id`,
    [mapVersionId],
  );
  return result.rows;
}

describe("runPublishMap (integration): map_binding_index population", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railway-publish-map-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("publishing a map inserts matching map_binding_index rows", async () => {
    const slug = uniqueSlug();
    const doc = minimalDoc(slug, "ZZ", "0001", "ZZ", "0002");
    const filePath = join(dir, "doc.json");
    await writeFile(filePath, JSON.stringify(doc), "utf8");

    await runPublishMap(testConfig, [slug, filePath]);

    const versionResult = await pool.query<{ id: string }>(
      `select mv.id as id from map_version mv join map m on m.id = mv.map_id where m.slug = $1`,
      [slug],
    );
    const versionId = versionResult.rows[0]?.id;
    expect(versionId).toBeDefined();

    const bindings = await bindingsFor(versionId!);
    expect(bindings).toEqual([
      { element_id: "berth-a", binding_type: "td_berth", td_area: "ZZ", berth: "0001" },
      { element_id: "berth-b", binding_type: "td_berth", td_area: "ZZ", berth: "0002" },
    ]);
  });

  it("republishing a new version never mutates the prior version's bindings", async () => {
    const slug = uniqueSlug();
    const docV1 = minimalDoc(slug, "ZZ", "0001", "ZZ", "0002");
    const filePathV1 = join(dir, "v1.json");
    await writeFile(filePathV1, JSON.stringify(docV1), "utf8");
    await runPublishMap(testConfig, [slug, filePathV1]);

    const v1Result = await pool.query<{ id: string }>(
      `select mv.id as id from map_version mv join map m on m.id = mv.map_id where m.slug = $1`,
      [slug],
    );
    const v1Id = v1Result.rows[0]?.id;

    const docV2 = minimalDoc(slug, "ZZ", "9999", "ZZ", "0002");
    const filePathV2 = join(dir, "v2.json");
    await writeFile(filePathV2, JSON.stringify(docV2), "utf8");
    await runPublishMap(testConfig, [
      slug,
      filePathV2,
      `--effective-from=${new Date(Date.now() + 1000).toISOString()}`,
    ]);

    const v1BindingsAfter = await bindingsFor(v1Id!);
    expect(v1BindingsAfter.find((b) => b.element_id === "berth-a")?.berth).toBe("0001");

    const v2Result = await pool.query<{ id: string }>(
      `select id from map_version where map_id = (select id from map where slug = $1) and id != $2`,
      [slug, v1Id],
    );
    const v2Id = v2Result.rows[0]?.id;
    const v2Bindings = await bindingsFor(v2Id!);
    expect(v2Bindings.find((b) => b.element_id === "berth-a")?.berth).toBe("9999");
  });
});
