import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerMapRoutes } from "./maps.js";

/**
 * Milestone 36b: signal state from S-Class bits through `/state?at=` and playback `/events`.
 *
 * Timeline (2026-05-02, one unique TD area):
 *   10:00  SG 00 (byte 03 = 04) + SG 04 (byte 04 = 01) — a full refresh
 *   10:10  SF 03 = 00
 *   10:20  last TD row before a silence (recorded feed_gap, ends 10:40)
 *   10:40  SF 03 = 04 — byte 03 re-confirmed; byte 04 is NOT re-confirmed
 *
 * Bindings: sig-1 = byte 03 bit 2, activeMeans "off" (set = off/green);
 *           sig-2 = byte 04 bit 0, activeMeans "on"  (set = on/red);
 *           sig-3 unbound.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `Y${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
const SLUG = `sig-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const rawEventIds: string[] = [];
let mapId: string;
let silenceStartSeq: string;

const bundle = {
  schemaVersion: 1,
  mapId: SLUG,
  mapName: "Signal Test",
  canvas: { width: 100, height: 100, gridSize: 10 },
  timezone: "Europe/London",
  layers: [],
  elementsById: {
    "sig-1": { id: "sig-1", type: "signal" },
    "sig-2": { id: "sig-2", type: "signal" },
    "sig-3": { id: "sig-3", type: "signal" },
  },
  berthBindingIndex: {},
  sBitBindingIndex: { [`${AREA}|03|2`]: "sig-1", [`${AREA}|04|0`]: "sig-2" },
  sBitBindingActiveMeans: { [`${AREA}|03|2`]: "off", [`${AREA}|04|0`]: "on" },
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
): Promise<string> {
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
  return row.ingestion_sequence;
}

beforeAll(async () => {
  const map = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'Signal Test') returning id`,
    [SLUG],
  );
  mapId = map.rows[0]!.id;
  await pool.query(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
        effective_from, effective_to, published_by, schema_version, checksum)
     values ($1, 1, '{}', $2, '2026-05-02T00:00:00Z', null, 'test', 1, 'v1')`,
    [mapId, JSON.stringify(bundle)],
  );

  await seedSEvent("2026-05-02T10:00:00Z", "SG_MSG", "00", { "00": 0, "01": 0, "02": 0, "03": 4 });
  await seedSEvent("2026-05-02T10:00:00Z", "SG_MSG", "04", { "04": 1, "05": 0, "06": 0, "07": 0 });
  await seedSEvent("2026-05-02T10:10:00Z", "SF_MSG", "03", { "03": 0 });
  silenceStartSeq = await seedSEvent("2026-05-02T10:20:00Z", "SF_MSG", "09", { "09": 0 });
  const silenceEndSeq = await seedSEvent("2026-05-02T10:40:00Z", "SF_MSG", "03", { "03": 4 });

  await pool.query(
    `insert into feed_gap (feed_name, td_area, detected_start, detected_end, detection_reason,
        recoverability, affected_sequence_start, affected_sequence_end,
        affected_time_start, affected_time_end)
     values ('TD', null, '2026-05-02T10:20:00Z', '2026-05-02T10:40:00Z', 'td_receive_silence',
        'unknown', $1, $2, '2026-05-02T10:20:00Z', '2026-05-02T10:40:00Z')`,
    [silenceStartSeq, silenceEndSeq],
  );
});

afterAll(async () => {
  await pool.query(
    "delete from feed_gap where detection_reason = 'td_receive_silence' and affected_sequence_start = $1",
    [silenceStartSeq],
  );
  await pool.query("delete from td_s_event where td_area = $1", [AREA]);
  if (rawEventIds.length > 0) {
    await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  }
  await pool.query("delete from map_version where map_id = $1", [mapId]);
  await pool.query("delete from map where id = $1", [mapId]);
  await pool.end();
});

async function buildApp() {
  const app = Fastify();
  await registerMapRoutes(app, { pool });
  await app.ready();
  return app;
}

async function signalsAt(iso: string): Promise<Record<string, { state: string }>> {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${SLUG}/state?at=${iso}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().signals;
  } finally {
    await app.close();
  }
}

describe("signal state from S-Class bits: /state?at= (integration)", () => {
  it("before any decoded data every signal is blank (unknown, never guessed)", async () => {
    expect(await signalsAt("2026-05-02T09:59:00Z")).toEqual({
      "sig-1": { state: "blank" },
      "sig-2": { state: "blank" },
      "sig-3": { state: "blank" },
    });
  });

  it("the bound bit decides on/off through activeMeans; unbound stays blank", async () => {
    expect(await signalsAt("2026-05-02T10:05:00Z")).toEqual({
      "sig-1": { state: "off" }, // byte 03 = 04: bit 2 set, activeMeans off → off
      "sig-2": { state: "on" }, // byte 04 = 01: bit 0 set, activeMeans on → on
      "sig-3": { state: "blank" },
    });
    expect((await signalsAt("2026-05-02T10:15:00Z"))["sig-1"]).toEqual({ state: "on" });
  });

  it("trusted for the first 5 minutes of a silence, blank after", async () => {
    const early = await signalsAt("2026-05-02T10:24:00Z");
    expect([early["sig-1"], early["sig-2"]]).toEqual([{ state: "on" }, { state: "on" }]);
    const late = await signalsAt("2026-05-02T10:30:00Z");
    expect([late["sig-1"], late["sig-2"]]).toEqual([{ state: "blank" }, { state: "blank" }]);
  });

  it("after the silence only re-confirmed bytes come back", async () => {
    const after = await signalsAt("2026-05-02T10:44:00Z");
    expect(after["sig-1"]).toEqual({ state: "off" });
    expect(after["sig-2"]).toEqual({ state: "blank" });
  });
});

describe("signal events in playback /events (integration)", () => {
  it("interleaves signal updates and the silence blank in sequence order", async () => {
    const app = await buildApp();
    try {
      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/events?from=2026-05-02T10:00:00Z&to=2026-05-02T11:00:00Z`,
        })
      ).json();
      const seen = body.events.map(
        (e: { type: string; elementId: string; state: string; eventAt: string }) => [
          e.elementId,
          e.state,
          e.eventAt,
        ],
      );
      expect(seen).toEqual([
        ["sig-1", "off", "2026-05-02T10:00:00.000Z"],
        ["sig-2", "on", "2026-05-02T10:00:00.000Z"],
        ["sig-1", "on", "2026-05-02T10:10:00.000Z"],
        ["sig-1", "blank", "2026-05-02T10:25:00.000Z"],
        ["sig-2", "blank", "2026-05-02T10:25:00.000Z"],
        ["sig-1", "off", "2026-05-02T10:40:00.000Z"],
      ]);
      const sequences = body.events.map((e: { sequence: number }) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(body.nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("pages with limit=1 without losing or repeating anything", async () => {
    const app = await buildApp();
    try {
      const collected: string[] = [];
      let after = "0";
      for (let page = 0; page < 20; page += 1) {
        const body = (
          await app.inject({
            method: "GET",
            url: `/api/v1/maps/${SLUG}/events?from=2026-05-02T10:00:00Z&to=2026-05-02T11:00:00Z&limit=1&after=${after}`,
          })
        ).json();
        for (const e of body.events as Array<{ elementId: string; state: string }>) {
          collected.push(`${e.elementId}:${e.state}`);
        }
        if (!body.nextCursor) break;
        after = body.nextCursor;
      }
      expect(collected).toEqual([
        "sig-1:off",
        "sig-2:on",
        "sig-1:on",
        "sig-1:blank",
        "sig-2:blank",
        "sig-1:off",
      ]);
    } finally {
      await app.close();
    }
  });
});
