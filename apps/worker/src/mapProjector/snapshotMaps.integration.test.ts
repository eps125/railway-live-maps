import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, reconstructMapStateAt } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { runSnapshotMaps, snapshotChecksumOf } from "./snapshotMaps.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
const SLUG = `snap-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
let mapId: string;
let mapVersionId: string;
const rawEventIds: string[] = [];

function bundle() {
  return {
    schemaVersion: 1,
    mapId: SLUG,
    mapName: "Snapshot Test",
    canvas: { width: 100, height: 100, gridSize: 10 },
    timezone: "Europe/London",
    layers: [],
    elementsById: {
      "berth-a": { id: "berth-a", type: "berth" },
      "sig-1": { id: "sig-1", type: "signal" },
    },
    berthBindingIndex: { [`${AREA}|0001`]: "berth-a" },
    sBitBindingIndex: {},
    boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    topologyAdjacency: {},
    continuationLinks: [],
  };
}

beforeAll(async () => {
  const map = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'Snapshot Test') returning id`,
    [SLUG],
  );
  mapId = map.rows[0]!.id;
  const mv = await pool.query<{ id: string }>(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
        effective_from, effective_to, published_by, schema_version, checksum)
     values ($1, 1, '{}', $2, now() - interval '1 day', null, 'test', 1, 'x') returning id`,
    [mapId, JSON.stringify(bundle())],
  );
  mapVersionId = mv.rows[0]!.id;

  // An open occupancy so the snapshot has something non-empty to record. Timestamps are passed
  // as explicit JS Dates (ms precision) — a SQL `now()` here would store microseconds that the
  // RETURNING round-trip truncates, breaking the composite FK into partitioned raw_feed_event.
  const eventAt = new Date(Date.now() - 120_000);
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
  const ev = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, ingestion_sequence`,
    [frame.rows[0]!.id, AREA, eventAt, randomUUID()],
  );
  rawEventIds.push(ev.rows[0]!.id);
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
        from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, 'CC', null, '0001', 'SNP1', $2, $4, 1)`,
    [ev.rows[0]!.id, eventAt, AREA, ev.rows[0]!.ingestion_sequence],
  );
  await pool.query(
    `insert into berth_occupancy (projection_version, td_area, berth_code, description, entered_at,
        left_at, entry_event_id, entry_event_normalized_at_utc, entry_reason)
     values ($1, $2, '0001', 'SNP1', $3, null, $4, $3, 'cc_interpose')`,
    [TD_PROJECTION_VERSION, AREA, eventAt, ev.rows[0]!.id],
  );
});

afterAll(async () => {
  await pool.query("delete from map_state_snapshot where map_version_id = $1", [mapVersionId]);
  await pool.query("delete from berth_occupancy where td_area = $1", [AREA]);
  await pool.query("delete from td_berth_event where td_area = $1", [AREA]);
  if (rawEventIds.length > 0) {
    await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  }
  await pool.query("delete from map_version where map_id = $1", [mapId]);
  await pool.query("delete from map where id = $1", [mapId]);
  await pool.end();
});

describe("runSnapshotMaps (integration)", () => {
  it("writes a snapshot whose state equals a fresh reconstruction at its snapshot_time", async () => {
    const summary = await runSnapshotMaps(pool);
    expect(summary.mapVersionsSnapshotted).toBeGreaterThanOrEqual(1);

    const row = (
      await pool.query<{
        snapshot_time: Date;
        last_event_sequence: string;
        state: { berths: Record<string, unknown>; signals: Record<string, unknown> };
        checksum: string;
      }>(
        `select snapshot_time, last_event_sequence, state, checksum
           from map_state_snapshot
          where map_version_id = $1
          order by snapshot_time desc limit 1`,
        [mapVersionId],
      )
    ).rows[0]!;

    // Snapshot content is the same computation /state?at= performs, at snapshot_time.
    const fresh = await reconstructMapStateAt(pool, {
      berthBindingIndex: { [`${AREA}|0001`]: "berth-a" },
      signalElementIds: ["sig-1"],
      projectionVersion: TD_PROJECTION_VERSION,
      at: row.snapshot_time,
    });

    expect(row.state.berths).toEqual(fresh.berths);
    expect(row.state.signals).toEqual(fresh.signals);
    expect(Number(row.last_event_sequence)).toBe(fresh.sourceSequence);
    expect(row.checksum).toBe(snapshotChecksumOf({ berths: fresh.berths, signals: fresh.signals }));
    expect(row.state.berths["berth-a"]).toEqual({
      description: "SNP1",
      enteredAt: expect.any(String),
    });
  });

  it("is idempotent for the same snapshot_time", async () => {
    const now = new Date("2026-05-02T00:00:00.000Z");
    const first = await runSnapshotMaps(pool, now);
    const second = await runSnapshotMaps(pool, now);
    expect(first.mapVersionsSnapshotted).toBeGreaterThanOrEqual(1);
    // Our map version was written by `first` and must be skipped (not re-inserted) by `second`.
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1);
    const rows = await pool.query(
      `select count(*)::int as n from map_state_snapshot
        where map_version_id = $1 and snapshot_time = $2`,
      [mapVersionId, now],
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
});
