import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { liveDataStatus } from "./mapVersion.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function seedHeartbeat(tdArea: string, eventAt: Date): Promise<void> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveResult.rows[0]!.id],
  );
  const eventResult = await pool.query<{ id: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CT', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id`,
    [frameResult.rows[0]!.id, tdArea, eventAt, randomUUID()],
  );
  await pool.query(
    `insert into td_heartbeat (raw_event_id, raw_event_normalized_at_utc, td_area, report_time, event_at, received_at)
     values ($1, $2, $3, $2, $2, now())`,
    [eventResult.rows[0]!.id, eventAt, tdArea],
  );
}

async function seedBerthEvent(tdArea: string, eventAt: Date): Promise<void> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveResult.rows[0]!.id],
  );
  const eventResult = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, ingestion_sequence`,
    [frameResult.rows[0]!.id, tdArea, eventAt, randomUUID()],
  );
  await pool.query(
    `insert into td_berth_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, to_berth,
       description, event_at, ingestion_sequence, normalization_version
     ) values ($1, $2, $3, 'CC', '0001', 'TEST', $2, $4, 1)`,
    [eventResult.rows[0]!.id, eventAt, tdArea, eventResult.rows[0]!.ingestion_sequence],
  );
}

describe("liveDataStatus (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("reports ok when the heartbeat is hours stale but real berth traffic is fresh", async () => {
    // Reproduces a real production finding (2026-08-09): Preston (PX) and Carlisle (CL) went
    // 4-5+ hours without a CT heartbeat while continuously reporting real CA/CB/CC berth
    // traffic seconds apart the entire time — NR's heartbeat message is not a reliable per-area
    // freshness signal on its own.
    const area = uniqueArea();
    const now = new Date();
    await seedHeartbeat(area, new Date(now.getTime() - 5 * 60 * 60 * 1000));
    await seedBerthEvent(area, new Date(now.getTime() - 5000));

    const status = await liveDataStatus(pool, [area], now);
    expect(status).toBe("ok");
  });

  it("reports stale when both heartbeat and berth traffic are old", async () => {
    const area = uniqueArea();
    const now = new Date();
    const old = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    await seedHeartbeat(area, old);
    await seedBerthEvent(area, old);

    const status = await liveDataStatus(pool, [area], now);
    expect(status).toBe("stale");
  });

  it("reports unknown when the area has never been observed", async () => {
    const status = await liveDataStatus(pool, [uniqueArea()], new Date());
    expect(status).toBe("unknown");
  });
});
