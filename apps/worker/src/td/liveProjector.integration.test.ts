import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import type { LiveDeltaMessage } from "@railway/protocol";
import { runProjectTdLive, type RedisPublisher } from "./liveProjector.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdTdAreas: string[] = [];
const createdSlugs: string[] = [];

afterAll(async () => {
  if (createdTdAreas.length > 0) {
    await pool.query("delete from berth_current_state where td_area = any($1::text[])", [
      createdTdAreas,
    ]);
    await pool.query(
      `delete from raw_feed_event where feed_name = 'TD' and td_area = any($1::text[])`,
      [createdTdAreas],
    );
  }
  if (createdSlugs.length > 0) {
    await pool.query(
      `delete from map_binding_index where map_version_id in (
         select mv.id from map_version mv join map m on m.id = mv.map_id where m.slug = any($1::text[])
       )`,
      [createdSlugs],
    );
    await pool.query(
      `delete from map_version where map_id in (select id from map where slug = any($1::text[]))`,
      [createdSlugs],
    );
    await pool.query("delete from map where slug = any($1::text[])", [createdSlugs]);
  }
  await pool.query(
    `delete from projection_checkpoint where projection_definition_id in (
       select id from projection_definition where name = 'td-live-berth-state'
     )`,
  );
  await pool.end();
});

function uniqueArea(): string {
  const a = `L${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  createdTdAreas.push(a);
  return a;
}

class CapturingRedis implements RedisPublisher {
  published: Array<{ channel: string; message: LiveDeltaMessage }> = [];
  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message: JSON.parse(message) as LiveDeltaMessage });
    return 1;
  }
}

/** Insert a TD C-Class raw_feed_event directly (no archive/S3 needed for this projector). */
async function seedCEvent(
  tdArea: string,
  eventType: "CA" | "CB" | "CC",
  msg: Record<string, string>,
  at: Date,
): Promise<void> {
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
  await pool.query(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, 'C', $3, $4, $5, $5, $6, 'parsed', 1)`,
    [
      frame.rows[0]!.id,
      eventType,
      tdArea,
      JSON.stringify({ [`${eventType}_MSG`]: msg }),
      at,
      randomUUID(),
    ],
  );
}

async function publishMapBinding(slug: string, elementId: string, tdArea: string, berth: string) {
  createdSlugs.push(slug);
  const map = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $1) returning id`,
    [slug],
  );
  const version = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 'test', 1, 'x') returning id`,
    [map.rows[0]!.id],
  );
  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, $2, 'td_berth', $3, $4)`,
    [version.rows[0]!.id, elementId, tdArea, berth],
  );
}

async function currentDescription(
  tdArea: string,
  berth: string,
): Promise<string | null | undefined> {
  const r = await pool.query<{ description: string | null }>(
    `select description from berth_current_state where td_area = $1 and berth_code = $2`,
    [tdArea, berth],
  );
  return r.rows[0]?.description;
}

describe("runProjectTdLive (integration)", () => {
  it("writes berth_current_state from CA/CB/CC and advances its own checkpoint", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await seedCEvent(
      area,
      "CC",
      { area_id: area, time: String(t), to: "0001", descr: "1A23" },
      new Date(t),
    );
    await seedCEvent(
      area,
      "CA",
      { area_id: area, time: String(t + 1000), from: "0001", to: "0002", descr: "1A23" },
      new Date(t + 1000),
    );

    const redis = new CapturingRedis();
    const summary = await runProjectTdLive(pool, redis, {});

    expect(summary.processedEvents).toBeGreaterThanOrEqual(2);
    expect(await currentDescription(area, "0001")).toBeNull(); // CA moved it out
    expect(await currentDescription(area, "0002")).toBe("1A23");

    // Re-running with no new events is a no-op (checkpoint held).
    const again = await runProjectTdLive(pool, redis, {});
    expect(again.processedEvents).toBe(0);
  });

  it("publishes a berth.updated / berth.cleared delta only for berths a published map binds", async () => {
    const area = uniqueArea();
    const slug = `live-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await publishMapBinding(slug, "berth-x", area, "0100");
    const t = Date.now();
    await seedCEvent(
      area,
      "CC",
      { area_id: area, time: String(t), to: "0100", descr: "2B22" },
      new Date(t),
    );
    await seedCEvent(
      area,
      "CC",
      { area_id: area, time: String(t + 1000), to: "0999", descr: "9Z99" }, // unbound berth
      new Date(t + 1000),
    );

    const redis = new CapturingRedis();
    await runProjectTdLive(pool, redis, {});

    const forSlug = redis.published.filter((p) => p.channel === `railway:live:${slug}`);
    expect(forSlug).toHaveLength(1);
    expect(forSlug[0]!.message).toMatchObject({
      type: "berth.updated",
      elementId: "berth-x",
      description: "2B22",
    });
    // Nothing published for the unbound 0999.
    expect(redis.published.some((p) => JSON.stringify(p.message).includes("9Z99"))).toBe(false);
  });

  it("does not regress a berth another writer already advanced past (monotonic guard)", async () => {
    const area = uniqueArea();
    const t = Date.now();

    // A normal CC for the berth, projected once so berth_current_state has a real row.
    await seedCEvent(
      area,
      "CC",
      { area_id: area, time: String(t), to: "0007", descr: "REAL" },
      new Date(t),
    );
    await runProjectTdLive(pool, new CapturingRedis(), {});
    expect(await currentDescription(area, "0007")).toBe("REAL");

    // Simulate the other writer (project-td-daemon) having advanced this berth far ahead.
    await pool.query(
      `update berth_current_state
       set description = 'AHEAD', source_ingestion_sequence = 9223372036854775000
       where td_area = $1 and berth_code = '0007'`,
      [area],
    );

    // A new (but lower-sequence) CC for the same berth must not overwrite the ahead state.
    await seedCEvent(
      area,
      "CC",
      { area_id: area, time: String(t + 5000), to: "0007", descr: "STALE" },
      new Date(t + 5000),
    );
    await runProjectTdLive(pool, new CapturingRedis(), {});
    expect(await currentDescription(area, "0007")).toBe("AHEAD");
  });
});
