import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { registerMapRoutes } from "./maps.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
const SLUG = `pb-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const rawEventIds: string[] = [];
let mapId: string;

function bundle(name: string) {
  return {
    schemaVersion: 1,
    mapId: SLUG,
    mapName: name,
    canvas: { width: 100, height: 100, gridSize: 10 },
    timezone: "Europe/London",
    layers: [],
    elementsById: {
      "berth-a": { id: "berth-a", type: "berth" },
      "berth-b": { id: "berth-b", type: "berth" },
      "sig-1": { id: "sig-1", type: "signal" },
    },
    berthBindingIndex: { [`${AREA}|0001`]: "berth-a", [`${AREA}|0002`]: "berth-b" },
    sBitBindingIndex: {},
    boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    topologyAdjacency: {},
    continuationLinks: [],
  };
}

/** Insert a TD C-Class raw_feed_event + its td_berth_event, returning the identity for FK use. */
async function seedTdEvent(
  eventAt: Date,
  messageType: "CA" | "CB" | "CC",
  fromBerth: string | null,
  toBerth: string | null,
  description: string | null,
): Promise<{ id: string; normalizedAt: Date; seq: string }> {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archive.rows[0]!.id],
  );
  const ev = await pool.query<{
    id: string;
    normalized_event_at_utc: Date;
    ingestion_sequence: string;
  }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, 'C', $3, '{}', $4, $4, $5, 'parsed', 1)
     returning id, normalized_event_at_utc, ingestion_sequence`,
    [frame.rows[0]!.id, messageType, AREA, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  await pool.query(
    `insert into td_berth_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth,
       description, event_at, ingestion_sequence, normalization_version
     ) values ($1, $2, $3, $4, $5, $6, $7, $2, $8, 1)`,
    [
      row.id,
      row.normalized_event_at_utc,
      AREA,
      messageType,
      fromBerth,
      toBerth,
      description,
      row.ingestion_sequence,
    ],
  );
  return { id: row.id, normalizedAt: row.normalized_event_at_utc, seq: row.ingestion_sequence };
}

async function seedOccupancy(
  berth: string,
  description: string,
  enteredAt: Date,
  leftAt: Date | null,
  entryEvent: { id: string; normalizedAt: Date },
): Promise<void> {
  await pool.query(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'cc_interpose')`,
    [
      TD_PROJECTION_VERSION,
      AREA,
      berth,
      description,
      enteredAt,
      leftAt,
      entryEvent.id,
      entryEvent.normalizedAt,
    ],
  );
}

const T = (iso: string): Date => new Date(iso);

beforeAll(async () => {
  const map = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'Playback Test') returning id`,
    [SLUG],
  );
  mapId = map.rows[0]!.id;
  // Two versions: v1 effective [T09, T12), v2 effective [T12, ∞).
  await pool.query(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
        effective_from, effective_to, published_by, schema_version, checksum)
     values ($1, 1, '{}', $2, '2026-05-01T09:00:00Z', '2026-05-01T12:00:00Z', 'test', 1, 'v1'),
            ($1, 2, '{}', $3, '2026-05-01T12:00:00Z', null, 'test', 1, 'v2')`,
    [mapId, JSON.stringify(bundle("Playback v1")), JSON.stringify(bundle("Playback v2"))],
  );

  // 0001: occupied by 1A11 from 09:58, cleared 10:30. 0002: 2B22 enters 10:15, still there.
  const e1 = await seedTdEvent(T("2026-05-01T09:58:00Z"), "CC", null, "0001", "1A11");
  await seedOccupancy("0001", "1A11", T("2026-05-01T09:58:00Z"), T("2026-05-01T10:30:00Z"), e1);
  const e2 = await seedTdEvent(T("2026-05-01T10:15:00Z"), "CC", null, "0002", "2B22");
  await seedOccupancy("0002", "2B22", T("2026-05-01T10:15:00Z"), null, e2);
  await seedTdEvent(T("2026-05-01T10:30:00Z"), "CB", "0001", null, null);

  await pool.query(
    `insert into feed_gap (feed_name, td_area, detected_start, detected_end, detection_reason,
        recoverability, affected_time_start, affected_time_end)
     values ('TD', $1, '2026-05-01T10:05:00Z', '2026-05-01T10:07:00Z', 'heartbeat lost',
        'unrecoverable', '2026-05-01T10:05:00Z', '2026-05-01T10:07:00Z')`,
    [AREA],
  );
});

afterAll(async () => {
  await pool.query("delete from feed_gap where td_area = $1", [AREA]);
  await pool.query("delete from berth_occupancy where td_area = $1", [AREA]);
  await pool.query("delete from td_berth_event where td_area = $1", [AREA]);
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

describe("GET /api/v1/maps/:slug/state?at= (integration)", () => {
  it("reconstructs berth state at a past instant and is byte-for-byte deterministic", async () => {
    const app = await buildApp();
    try {
      const url = `/api/v1/maps/${SLUG}/state?at=2026-05-01T10:20:00Z`;
      const a = await app.inject({ method: "GET", url });
      const b = await app.inject({ method: "GET", url });
      expect(a.statusCode).toBe(200);
      expect(a.body).toEqual(b.body); // deterministic (M10 acceptance)

      const body = a.json();
      expect(body.mode).toBe("historical");
      expect(body.mapVersion).toBe(1); // version effective at 10:20
      expect(body.berths["berth-a"]).toEqual({
        description: "1A11",
        enteredAt: "2026-05-01T09:58:00.000Z",
      });
      expect(body.berths["berth-b"]).toEqual({
        description: "2B22",
        enteredAt: "2026-05-01T10:15:00.000Z",
      });
      expect(body.signals["sig-1"]).toEqual({ state: "blank" });
      expect(body.sourceSequence).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("shows 0001 clear after 10:30 and reports the feed gap that covered 10:06", async () => {
    const app = await buildApp();
    try {
      const after = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/state?at=2026-05-01T10:45:00Z`,
        })
      ).json();
      expect(after.berths["berth-a"]).toEqual({ description: null, enteredAt: null });

      const during = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/state?at=2026-05-01T10:06:00Z`,
        })
      ).json();
      expect(during.quality.status).toBe("stale");
      expect(during.quality.gaps.join(" ")).toContain("feed gap");
    } finally {
      await app.close();
    }
  });

  it("selects the map version effective at `at`, not now", async () => {
    const app = await buildApp();
    try {
      const v1 = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/state?at=2026-05-01T10:00:00Z`,
        })
      ).json();
      const v2 = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/state?at=2026-05-01T13:00:00Z`,
        })
      ).json();
      expect(v1.mapVersion).toBe(1);
      expect(v2.mapVersion).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/maps/:slug/events (integration)", () => {
  it("returns element-resolved deltas in sequence order with a working cursor", async () => {
    const app = await buildApp();
    try {
      const all = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/events?from=2026-05-01T09:00:00Z&to=2026-05-01T11:00:00Z`,
        })
      ).json();
      // CC 0001, CC 0002, CB 0001 → berth.updated a, berth.updated b, berth.cleared a
      expect(
        all.events.map((e: { type: string; elementId: string }) => [e.type, e.elementId]),
      ).toEqual([
        ["berth.updated", "berth-a"],
        ["berth.updated", "berth-b"],
        ["berth.cleared", "berth-a"],
      ]);
      const seqs = all.events.map((e: { sequence: number }) => e.sequence);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));

      // Page with limit=1 + cursor.
      const p1 = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/events?from=2026-05-01T09:00:00Z&to=2026-05-01T11:00:00Z&limit=1`,
        })
      ).json();
      expect(p1.events).toHaveLength(1);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${SLUG}/events?from=2026-05-01T09:00:00Z&to=2026-05-01T11:00:00Z&limit=1&after=${p1.nextCursor}`,
        })
      ).json();
      expect(p2.events[0].sequence).toBeGreaterThan(p1.events[0].sequence);
    } finally {
      await app.close();
    }
  });
});
