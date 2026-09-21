import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerMapRoutes } from "./maps.js";

/**
 * Milestone 59 / ADR 0015: a crossing whose barrier position is inferred from its protecting
 * signals, through `/state?at=` (the snapshot) and playback `/events`. The two must agree at every
 * point (CLAUDE.md rule 13), and playback must get it right even when a page starts on a row that
 * restates only ONE of the two inputs — which is what the per-page seed exists for.
 *
 * Modelled on the owner's Carleton crossing: S3879 at byte 07 bit 4 and S3870 at byte 06 bit 6,
 * a set bit meaning the signal is off. Timeline (2026-05-03, one unique TD area):
 *
 *   10:00  SG 04 (bytes 04-07 all 0)  both signals at danger          -> raised
 *   10:05  SF 07 = 10                 S3879 at proceed                -> lowered
 *   10:07  SF 07 = 00                 both at danger again            -> raised
 *   10:09  SF 06 = 40                 S3870 at proceed                -> lowered
 *   10:20  last TD row before a silence (feed_gap to 10:40); blank at 10:25
 *   10:40  SF 07 = 00                 S3879 re-confirmed at danger, but S3870 NOT re-confirmed
 *                                     since the silence                -> unknown (blank)
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `X${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
const SLUG = `lxi-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const CROSSING = "lx-carleton";
const rawEventIds: string[] = [];
let mapId: string;
let silenceStartSeq: string;

const bundle = {
  schemaVersion: 1,
  mapId: SLUG,
  mapName: "Inferred Crossing Test",
  canvas: { width: 100, height: 100, gridSize: 10 },
  timezone: "Europe/London",
  layers: [],
  elementsById: {
    [CROSSING]: { id: CROSSING, type: "levelCrossing" },
  },
  berthBindingIndex: {},
  sBitBindingIndex: {},
  inferredBarrierBindings: {
    [CROSSING]: [
      { tdArea: AREA, address: "07", bit: 4, activeMeans: "off" },
      { tdArea: AREA, address: "06", bit: 6, activeMeans: "off" },
    ],
  },
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
    `insert into map (slug, name) values ($1, 'Inferred Crossing Test') returning id`,
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
  await seedSEvent("2026-05-03T10:07:00Z", "SF_MSG", "07", { "07": 0x00 });
  await seedSEvent("2026-05-03T10:09:00Z", "SF_MSG", "06", { "06": 0x40 });
  silenceStartSeq = await seedSEvent("2026-05-03T10:20:00Z", "SF_MSG", "09", { "09": 0 });
  const silenceEndSeq = await seedSEvent("2026-05-03T10:40:00Z", "SF_MSG", "07", { "07": 0x00 });

  await pool.query(
    `insert into feed_gap (feed_name, td_area, detected_start, detected_end, detection_reason,
        recoverability, affected_sequence_start, affected_sequence_end,
        affected_time_start, affected_time_end)
     values ('TD', null, '2026-05-03T10:20:00Z', '2026-05-03T10:40:00Z', 'td_receive_silence',
        'unknown', $1, $2, '2026-05-03T10:20:00Z', '2026-05-03T10:40:00Z')`,
    [silenceStartSeq, silenceEndSeq],
  );
});

afterAll(async () => {
  // Scoped to this file's own silence: a nationwide feed gap left behind suppresses step-chain
  // propagation in every later test file (the 2026-09-20 freshResolution failure, f2e8918).
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

async function crossingAt(iso: string): Promise<string> {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${SLUG}/state?at=${iso}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().crossings[CROSSING].state;
  } finally {
    await app.close();
  }
}

/** Playback's crossing states, with the time each applies. */
const EXPECTED_PLAYBACK = [
  ["up", "2026-05-03T10:00:00.000Z"],
  ["down", "2026-05-03T10:05:00.000Z"],
  ["up", "2026-05-03T10:07:00.000Z"],
  ["down", "2026-05-03T10:09:00.000Z"],
  ["blank", "2026-05-03T10:25:00.000Z"],
  ["blank", "2026-05-03T10:40:00.000Z"],
];

describe("inferred crossing: /state?at= (integration)", () => {
  it("is blank before any decoded data", async () => {
    expect(await crossingAt("2026-05-03T09:59:00Z")).toBe("blank");
  });

  it("is raised with both signals at danger, lowered with either at proceed", async () => {
    expect(await crossingAt("2026-05-03T10:01:00Z")).toBe("up");
    expect(await crossingAt("2026-05-03T10:06:00Z")).toBe("down");
    expect(await crossingAt("2026-05-03T10:08:00Z")).toBe("up");
    expect(await crossingAt("2026-05-03T10:10:00Z")).toBe("down");
  });

  it("trusts its inputs through the first 5 minutes of a silence, and is unknown after", async () => {
    expect(await crossingAt("2026-05-03T10:24:00Z")).toBe("down");
    expect(await crossingAt("2026-05-03T10:30:00Z")).toBe("blank");
  });

  it("stays unknown when only one input is re-confirmed — never raised on a guess", async () => {
    expect(await crossingAt("2026-05-03T10:41:00Z")).toBe("blank");
  });
});

describe("inferred crossing: playback /events (integration)", () => {
  it("emits the combined state in sequence order, matching the snapshot", async () => {
    const app = await buildApp();
    try {
      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/events?from=2026-05-03T10:00:00Z&to=2026-05-03T11:00:00Z`,
        })
      ).json();
      const seen = (
        body.events as Array<{ type: string; elementId: string; state: string; eventAt: string }>
      )
        .filter((e) => e.elementId === CROSSING)
        .map((e) => {
          expect(e.type).toBe("crossing.updated");
          return [e.state, e.eventAt];
        });
      expect(seen).toEqual(EXPECTED_PLAYBACK);
      // The inputs are internal: no signal.updated leaks out for a bit that only feeds a crossing.
      expect(body.events.some((e: { type: string }) => e.type === "signal.updated")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("pages with limit=1 — each page seeding the input it does not restate — without drift", async () => {
    const app = await buildApp();
    try {
      const collected: string[][] = [];
      let after = "0";
      for (let page = 0; page < 20; page += 1) {
        const body = (
          await app.inject({
            method: "GET",
            url: `/api/v1/maps/${SLUG}/events?from=2026-05-03T10:00:00Z&to=2026-05-03T11:00:00Z&limit=1&after=${after}`,
          })
        ).json();
        for (const e of body.events as Array<{
          elementId: string;
          state: string;
          eventAt: string;
        }>) {
          if (e.elementId === CROSSING) collected.push([e.state, e.eventAt]);
        }
        if (!body.nextCursor) break;
        after = body.nextCursor;
      }
      expect(collected).toEqual(EXPECTED_PLAYBACK);
    } finally {
      await app.close();
    }
  });
});
