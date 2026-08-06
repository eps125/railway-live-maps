import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { LiveDeltaMessage } from "@railway/protocol";
import { createPollingDeltaSource } from "./pollingDeltaSource.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function publishMapBoundTo(
  slug: string,
  elementId: string,
  tdArea: string,
  berth: string,
): Promise<string> {
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $2) returning id`,
    [slug, slug],
  );
  const mapId = mapResult.rows[0]!.id;

  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 'test', 1, 'test-checksum')
     returning id`,
    [mapId],
  );
  const mapVersionId = versionResult.rows[0]!.id;

  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, $2, 'td_berth', $3, $4)`,
    [mapVersionId, elementId, tdArea, berth],
  );

  return mapVersionId;
}

/** Same full-FK-chain helper as routes/liveMap.integration.test.ts. */
async function setBerthCurrentState(
  tdArea: string,
  berth: string,
  description: string,
): Promise<void> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const archiveObjectId = archiveResult.rows[0]!.id;

  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveObjectId],
  );
  const frameId = frameResult.rows[0]!.id;

  const now = new Date();
  const eventResult = await pool.query<{ id: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CA', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id`,
    [frameId, tdArea, now, randomUUID()],
  );
  const eventId = eventResult.rows[0]!.id;

  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_entered_at, event_at,
       source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, $3, $4, $5, $5, $6, $5, (select ingestion_sequence from raw_feed_event where id = $6))
     on conflict (projection_version, td_area, berth_code) do update set
       description = excluded.description, occupancy_entered_at = excluded.occupancy_entered_at,
       event_at = excluded.event_at, source_event_id = excluded.source_event_id,
       source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
       source_ingestion_sequence = excluded.source_ingestion_sequence`,
    [TD_PROJECTION_VERSION, tdArea, berth, description, now, eventId],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createPollingDeltaSource (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("emits deltas only for a map's own bound area/berth, while an unrelated area's nationwide rows remain retained and untouched", async () => {
    const lancasterArea = uniqueArea();
    const otherArea = uniqueArea();
    const slug = `test-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const mapVersionId = await publishMapBoundTo(slug, "berth-lancaster", lancasterArea, "0001");

    const deltaSource = createPollingDeltaSource(pool, 100);
    const received: LiveDeltaMessage[] = [];
    const unsubscribe = deltaSource.subscribe(mapVersionId, slug, (message) =>
      received.push(message),
    );

    // Let the seed query settle before mutating state (mirrors pollingDeltaSource.ts's own
    // seed-before-poll ordering, so this isn't racing the adapter's own bootstrap).
    await sleep(150);

    // A nationwide event for an area this map does NOT bind — must be retained (append-only,
    // never filtered by map scope) but must never produce a delta for this map's socket.
    await setBerthCurrentState(otherArea, "9999", "OTHER");
    // A nationwide event for the area this map DOES bind — must produce exactly one delta.
    await setBerthCurrentState(lancasterArea, "0001", "1A23");

    await sleep(400);
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "berth.updated",
      elementId: "berth-lancaster",
      tdArea: lancasterArea,
      berth: "0001",
      description: "1A23",
    });

    // Nationwide retention proof: the unrelated area's row exists in the DB even though no
    // published map (and therefore no live delta) ever referenced it.
    const otherRow = await pool.query(
      `select description from berth_current_state where td_area = $1 and berth_code = $2 and projection_version = $3`,
      [otherArea, "9999", TD_PROJECTION_VERSION],
    );
    expect(otherRow.rows).toEqual([{ description: "OTHER" }]);
  });
});
