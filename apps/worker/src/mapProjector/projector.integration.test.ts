import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import type { LiveDeltaMessage } from "@railway/protocol";
import { recordFrame, markFrameAcked, type InboundFrame } from "../td/recorder.js";
import { runProjectTd } from "../td/projector.js";
import { runProjectMapDeltas, type RedisPublisher } from "./projector.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

/** Same fake used by td/recorder.integration.test.ts — no MinIO in this sandbox. */
class FakeS3Client {
  send = async (): Promise<Record<string, never>> => ({});
}

/** Captures published messages instead of touching a real Redis — this sandbox has no Redis
 * server to test a true pub/sub round trip against (mirrors the FakeS3Client/no-MinIO
 * situation); the channel/message *shape* is what this suite proves, and
 * apps/api/src/live/redisDeltaSource.test.ts separately proves the subscriber side against the
 * same shape using its own fake. */
class CapturingRedisPublisher implements RedisPublisher {
  published: Array<{ channel: string; message: LiveDeltaMessage }> = [];
  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message: JSON.parse(message) as LiveDeltaMessage });
    return 1;
  }
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new FakeS3Client() as unknown as S3Client;
const bucket = "railway-raw-test";

function frameFor(children: unknown[], receivedAt: Date): InboundFrame {
  return {
    feedName: "TD",
    topic: "/topic/TD_ALL_SIG_AREA",
    brokerMessageId: randomUUID(),
    headers: {},
    body: Buffer.from(JSON.stringify(children), "utf8"),
    receivedAt,
    connectionSessionId: null,
  };
}

async function record(children: unknown[], receivedAt: Date): Promise<void> {
  const result = await recordFrame(frameFor(children, receivedAt), {
    pool,
    archiveClient,
    archiveBucket: bucket,
  });
  await markFrameAcked(pool, result.frameId);
}

const cc = (area: string, to: string, descr: string, t: number) => ({
  CC_MSG: { area_id: area, time: String(t), to, descr },
});
const cb = (area: string, from: string, descr: string, t: number) => ({
  CB_MSG: { area_id: area, time: String(t), from, descr },
});

function uniqueArea(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

async function publishMapBoundTo(
  slug: string,
  elementId: string,
  tdArea: string,
  berth: string,
): Promise<void> {
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $2) returning id`,
    [slug, slug],
  );
  const mapId = mapResult.rows[0]!.id;
  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 'test', 1, 'test-checksum') returning id`,
    [mapId],
  );
  const mapVersionId = versionResult.rows[0]!.id;
  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, $2, 'td_berth', $3, $4)`,
    [mapVersionId, elementId, tdArea, berth],
  );
}

describe("runProjectMapDeltas (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("publishes a delta only to maps that bind the changed berth, using the real ingestion_sequence", async () => {
    const area = uniqueArea();
    const slug = `test-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await publishMapBoundTo(slug, "berth-1", area, "0001");

    await record([cc(area, "0001", "1A23", 1000)], new Date());
    await runProjectTd(pool);

    const redis = new CapturingRedisPublisher();
    const summary = await runProjectMapDeltas(pool, redis);

    expect(summary.publishedDeltas).toBeGreaterThanOrEqual(1);
    const forThisSlug = redis.published.filter((p) => p.channel === `railway:live:${slug}`);
    expect(forThisSlug).toHaveLength(1);
    expect(forThisSlug[0]!.message).toMatchObject({
      type: "berth.updated",
      elementId: "berth-1",
      tdArea: area,
      berth: "0001",
      description: "1A23",
    });
  });

  it("publishes nothing for an area/berth no published map binds", async () => {
    const area = uniqueArea();
    await record([cc(area, "0002", "9Z99", 2000)], new Date());
    await runProjectTd(pool);

    const redis = new CapturingRedisPublisher();
    await runProjectMapDeltas(pool, redis);

    const hasMatch = redis.published.some(
      (p) =>
        (p.message.type === "berth.updated" || p.message.type === "berth.cleared") &&
        p.message.tdArea === area,
    );
    expect(hasMatch).toBe(false);
  });

  it("is checkpointed: re-running without new events publishes nothing further", async () => {
    const area = uniqueArea();
    const slug = `test-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await publishMapBoundTo(slug, "berth-1", area, "0003");
    await record([cc(area, "0003", "1A99", 3000)], new Date());
    await runProjectTd(pool);

    const redis1 = new CapturingRedisPublisher();
    await runProjectMapDeltas(pool, redis1);
    expect(redis1.published).toHaveLength(1);

    const redis2 = new CapturingRedisPublisher();
    await runProjectMapDeltas(pool, redis2);
    expect(redis2.published).toHaveLength(0);
  });

  it("a CB (cancel) publishes a berth.cleared delta", async () => {
    const area = uniqueArea();
    const slug = `test-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await publishMapBoundTo(slug, "berth-1", area, "0004");
    await record([cc(area, "0004", "1B22", 4000), cb(area, "0004", "1B22", 4100)], new Date());
    await runProjectTd(pool);

    const redis = new CapturingRedisPublisher();
    await runProjectMapDeltas(pool, redis);

    const types = redis.published.map((p) => p.message.type);
    expect(types).toEqual(["berth.updated", "berth.cleared"]);
  });

  async function currentOccupancy(
    tdArea: string,
    berth: string,
  ): Promise<{ id: string; entered_at: Date }> {
    const result = await pool.query<{ id: string; entered_at: Date }>(
      `select id, entered_at from berth_occupancy
       where td_area = $1 and berth_code = $2 order by entered_at desc limit 1`,
      [tdArea, berth],
    );
    return result.rows[0]!;
  }

  async function seedResolution(
    occupancy: { id: string; entered_at: Date },
    status: "matched" | "ambiguous" | "unmatched",
    selectedTrainRunId: string | null,
  ): Promise<void> {
    await pool.query(
      `insert into berth_run_resolution (
         occupancy_id, occupancy_entered_at, status, selected_train_run_id, resolver_version, decided_at
       ) values ($1, $2, $3, $4, 1, now())`,
      [occupancy.id, occupancy.entered_at, status, selectedTrainRunId],
    );
  }

  it("publishes run.resolution.updated for a resolution decided on the berth's current occupancy", async () => {
    const area = uniqueArea();
    const slug = `test-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await publishMapBoundTo(slug, "berth-1", area, "0005");
    await record([cc(area, "0005", "1C55", 5000)], new Date());
    await runProjectTd(pool);
    const occupancy = await currentOccupancy(area, "0005");
    await seedResolution(occupancy, "ambiguous", null);

    const redis = new CapturingRedisPublisher();
    await runProjectMapDeltas(pool, redis);

    const forThisSlug = redis.published.filter((p) => p.channel === `railway:live:${slug}`);
    const resolutionMessages = forThisSlug.filter(
      (p) => p.message.type === "run.resolution.updated",
    );
    expect(resolutionMessages).toHaveLength(1);
    expect(resolutionMessages[0]!.message).toMatchObject({
      type: "run.resolution.updated",
      elementId: "berth-1",
      runSummary: { status: "ambiguous", text: null, trainRunId: null },
    });
  });

  it("does not publish a resolution for an occupancy the berth has already stepped away from", async () => {
    const area = uniqueArea();
    const slug = `test-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await publishMapBoundTo(slug, "berth-1", area, "0006");
    await record([cc(area, "0006", "1D66", 6000)], new Date());
    await runProjectTd(pool);
    const staleOccupancy = await currentOccupancy(area, "0006");
    await seedResolution(staleOccupancy, "unmatched", null);

    // The train steps away from 0006 before the resolver's decision gets published — the berth's
    // *current* occupancy is no longer staleOccupancy, so that resolution is now stale.
    await record([cc(area, "0006", "1D77", 6100)], new Date());
    await runProjectTd(pool);

    const redis = new CapturingRedisPublisher();
    await runProjectMapDeltas(pool, redis);

    const staleMessage = redis.published.find(
      (p) => p.message.type === "run.resolution.updated" && p.message.elementId === "berth-1",
    );
    expect(staleMessage).toBeUndefined();
  });
});
