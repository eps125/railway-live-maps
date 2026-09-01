import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { compileMapDocument, MapDocumentSchema } from "@railway/map-schema";
import { runBackfillMapBindings } from "./backfillMapBindings.js";
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
  RESOLVER_EAGER_MAPPED_AREAS_ONLY: false,
  LIVE_WS_REDIS_PUBSUB_ENABLED: false,
  NR_USERNAME: undefined,
  NR_PASSWORD: undefined,
};

function uniqueSlug(): string {
  return `test-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Inserts a map_version row directly, bypassing publish-map's own binding-index insert — this
 * simulates a version published before migration 0010 existed (Milestone 5 vintage), which is
 * exactly the situation backfill-map-bindings exists to repair. */
async function insertBareMapVersion(slug: string, area: string, berth: string): Promise<string> {
  const doc = MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: slug,
      name: slug,
      canvas: { width: 10, height: 10, gridSize: 1 },
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
        width: 1,
        height: 1,
        displayName: "A",
        bindingId: "bind-a",
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [{ id: "bind-a", elementId: "berth-a", type: "tdBerth", tdArea: area, berth }],
  });
  const bundle = compileMapDocument(doc);

  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $2) returning id`,
    [slug, slug],
  );
  const mapId = mapResult.rows[0]!.id;

  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, $2, $3, now(), 'test', 1, 'test-checksum')
     returning id`,
    [mapId, JSON.stringify(doc), JSON.stringify(bundle)],
  );
  return versionResult.rows[0]!.id;
}

async function bindingCount(mapVersionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from map_binding_index where map_version_id = $1`,
    [mapVersionId],
  );
  return Number(result.rows[0]!.count);
}

describe("runBackfillMapBindings (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("populates bindings for a map_version that has none, and is idempotent on re-run", async () => {
    const versionId = await insertBareMapVersion(uniqueSlug(), "ZZ", "1234");
    expect(await bindingCount(versionId)).toBe(0);

    await runBackfillMapBindings(testConfig);
    expect(await bindingCount(versionId)).toBe(1);

    await runBackfillMapBindings(testConfig);
    expect(await bindingCount(versionId)).toBe(1);
  });
});
