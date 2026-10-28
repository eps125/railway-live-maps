import { randomUUID } from "node:crypto";
import { appAs } from "../lib/testViewers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerMapRoutes } from "./maps.js";

/**
 * Milestone 92 fix (owner report 2026-10-27): a TRTS lit before the page loaded, or before the
 * moment playback jumped to, never showed — `/state` (which the live map loads from and playback
 * seeks with) resolved the TRTS but left it out of its response, so only a later `trts.updated`
 * could light the dot. Signals and routes were unaffected because they were in the response.
 *
 * One unique TD area, the TRTS on byte 07 bit 4 (set = lit):
 *
 *   10:00  SG 04 (bytes 04-07 all 0)   unlit
 *   10:05  SF 07 = 10                  lit
 *   10:10  SF 07 = 00                  unlit (the signal has cleared)
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `T${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
const SLUG = `trts-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const SIGNAL = "sig-start";
const rawEventIds: string[] = [];
let mapId: string;

const bundle = {
  schemaVersion: 1,
  mapId: SLUG,
  mapName: "TRTS Test",
  canvas: { width: 100, height: 100, gridSize: 10 },
  timezone: "Europe/London",
  layers: [],
  elementsById: {
    [SIGNAL]: { id: SIGNAL, type: "signal" },
  },
  berthBindingIndex: {},
  sBitBindingIndex: {},
  trtsBindingIndex: { [`${AREA}|07|4`]: SIGNAL },
  trtsBindingActiveMeans: { [`${AREA}|07|4`]: "lit" },
  placeBindingIndex: [],
  boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  topologyAdjacency: {},
  continuationLinks: [],
};

/** A decoded S-Class event: raw_feed_event + td_s_event, as `project-td` writes them. */
async function seedSEvent(
  at: string,
  type: "SF_MSG" | "SG_MSG",
  address: string,
  bytes: Record<string, number>,
): Promise<void> {
  const eventAt = new Date(at);
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', $2, $1, $3) returning id`,
    [randomUUID(), eventAt, archive.rows[0]!.id],
  );
  const ev = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, 'S', $3, '{}', $4, $4, $5, 'parsed', 1)
     returning id, ingestion_sequence::text`,
    [frame.rows[0]!.id, type, AREA, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  await pool.query(
    `insert into td_s_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, address, raw_value,
       decoded_bitset, event_at, ingestion_sequence, normalization_version, decode_status,
       decode_version
     ) values ($1, $2, $3, $4, $5, 'xx', $6, $2, $7, 1, 'decoded', 1)`,
    [row.id, eventAt, AREA, type, address, JSON.stringify({ bytes }), row.ingestion_sequence],
  );
}

beforeAll(async () => {
  const map = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'TRTS Test') returning id`,
    [SLUG],
  );
  mapId = map.rows[0]!.id;
  await pool.query(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
        effective_from, effective_to, published_by, schema_version, checksum)
     values ($1, 1, '{}', $2, '2026-05-03T00:00:00Z', null, 'test', 1, 'v1')`,
    [mapId, JSON.stringify(bundle)],
  );
  await seedSEvent("2026-05-03T10:00:00Z", "SG_MSG", "04", { "04": 0, "05": 0, "06": 0, "07": 0 });
  await seedSEvent("2026-05-03T10:05:00Z", "SF_MSG", "07", { "07": 0x10 });
  await seedSEvent("2026-05-03T10:10:00Z", "SF_MSG", "07", { "07": 0x00 });
});

afterAll(async () => {
  await pool.query("delete from td_s_event where td_area = $1", [AREA]);
  if (rawEventIds.length > 0) {
    await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  }
  await pool.query("delete from map_version where map_id = $1", [mapId]);
  await pool.query("delete from map where id = $1", [mapId]);
  await pool.end();
});

async function trtsAt(iso: string): Promise<unknown> {
  const app = appAs();
  await registerMapRoutes(app, { pool });
  await app.ready();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${SLUG}/state?at=${iso}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().trts;
  } finally {
    await app.close();
  }
}

describe("TRTS in /state?at= (integration)", () => {
  it("is blank before any decoded data", async () => {
    expect(await trtsAt("2026-05-03T09:59:00Z")).toEqual({ [SIGNAL]: { state: "blank" } });
  });

  it("shows a TRTS lit before the requested moment, not only when it changes", async () => {
    expect(await trtsAt("2026-05-03T10:01:00Z")).toEqual({ [SIGNAL]: { state: "unlit" } });
    expect(await trtsAt("2026-05-03T10:07:00Z")).toEqual({ [SIGNAL]: { state: "lit" } });
    expect(await trtsAt("2026-05-03T10:11:00Z")).toEqual({ [SIGNAL]: { state: "unlit" } });
  });
});
