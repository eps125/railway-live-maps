import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { recordFrame, markFrameAcked, type InboundFrame } from "./recorder.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

/**
 * MinIO is not available in this sandbox — the S3 side is faked in-memory here so the
 * (much more important) Postgres idempotency/transaction behavior can still be proven
 * against a real database. Real S3/MinIO connectivity is exercised separately by
 * packages/archive's own tests and the CI `ensure-archive-bucket`/`check-connectivity` steps.
 */
class FakeS3Client {
  objects = new Map<string, Buffer>();
  send = async (command: {
    input?: { Key?: string; Body?: Buffer };
  }): Promise<Record<string, never>> => {
    if (command.input?.Key && command.input.Body) {
      this.objects.set(command.input.Key, Buffer.from(command.input.Body));
    }
    return {};
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new FakeS3Client() as unknown as S3Client;
const bucket = "railway-raw-test";

function makeFrame(bodyText: string, overrides: Partial<InboundFrame> = {}): InboundFrame {
  return {
    feedName: "TD",
    topic: "/topic/TD_ALL_SIG_AREA",
    brokerMessageId: randomUUID(),
    headers: {},
    body: Buffer.from(bodyText, "utf8"),
    receivedAt: new Date(),
    connectionSessionId: null,
    ...overrides,
  };
}

describe("recordFrame (integration)", () => {
  // Unique per test run so parallel/repeated runs against a shared DB never collide.
  const areaPrefix = `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const createdFrameIds: string[] = [];

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    if (createdFrameIds.length > 0) {
      await pool.query("delete from raw_feed_event where frame_id = any($1::bigint[])", [
        createdFrameIds,
      ]);
      await pool.query("delete from feed_frame where id = any($1::bigint[])", [createdFrameIds]);
      createdFrameIds.length = 0;
    }
  });

  it("records a fresh frame with every child row, including unsupported ones — never dropped", async () => {
    const body = JSON.stringify([
      {
        CA_MSG: {
          area_id: areaPrefix,
          time: String(Date.now()),
          from: "0001",
          to: "0002",
          descr: "TEST",
        },
      },
      { XX_MSG: { area_id: areaPrefix, note: "deliberately unrecognized" } },
    ]);

    const result = await recordFrame(makeFrame(body), {
      pool,
      archiveClient,
      archiveBucket: bucket,
    });
    createdFrameIds.push(result.frameId);

    expect(result.alreadyRecorded).toBe(false);
    expect(result.childCount).toBe(2);
    expect(result.parsedChildCount).toBe(1);
    expect(result.unsupportedChildCount).toBe(1);

    const rows = await pool.query<{ event_type: string; parse_status: string }>(
      "select event_type, parse_status from raw_feed_event where frame_id = $1 order by child_index",
      [result.frameId],
    );
    expect(rows.rows).toEqual([
      { event_type: "CA", parse_status: "parsed" },
      { event_type: "XX_MSG", parse_status: "unsupported" },
    ]);
  });

  it("is idempotent under exact-byte redelivery: the second call is a safe no-op", async () => {
    const body = JSON.stringify([
      { CT_MSG: { area_id: areaPrefix, report_time: String(Date.now()) } },
    ]);
    const frame = makeFrame(body);

    const first = await recordFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(first.frameId);
    const second = await recordFrame(frame, { pool, archiveClient, archiveBucket: bucket });

    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.frameId).toBe(first.frameId);

    const frameCount = await pool.query<{ n: number }>(
      "select count(*)::int as n from feed_frame where id = $1",
      [first.frameId],
    );
    expect(frameCount.rows[0]?.n).toBe(1);

    const eventCount = await pool.query<{ n: number }>(
      "select count(*)::int as n from raw_feed_event where frame_id = $1",
      [first.frameId],
    );
    expect(eventCount.rows[0]?.n).toBe(1);
  });

  it("retains multiple distinct TD areas in the same run without any filtering", async () => {
    const bodyA = JSON.stringify([
      { CT_MSG: { area_id: `${areaPrefix}A`, report_time: String(Date.now()) } },
    ]);
    const bodyB = JSON.stringify([
      { CT_MSG: { area_id: `${areaPrefix}B`, report_time: String(Date.now()) } },
    ]);

    const resultA = await recordFrame(makeFrame(bodyA), {
      pool,
      archiveClient,
      archiveBucket: bucket,
    });
    const resultB = await recordFrame(makeFrame(bodyB), {
      pool,
      archiveClient,
      archiveBucket: bucket,
    });
    createdFrameIds.push(resultA.frameId, resultB.frameId);

    const areas = await pool.query<{ td_area: string }>(
      "select distinct td_area from raw_feed_event where frame_id = any($1::bigint[]) order by td_area",
      [[resultA.frameId, resultB.frameId]],
    );
    expect(areas.rows.map((r) => r.td_area)).toEqual([`${areaPrefix}A`, `${areaPrefix}B`]);
  });

  it("survives a crash-before-redelivery scenario: recordFrame after ack is still idempotent", async () => {
    const body = JSON.stringify([
      { CT_MSG: { area_id: areaPrefix, report_time: String(Date.now()) } },
    ]);
    const frame = makeFrame(body);

    const result = await recordFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(result.frameId);
    await markFrameAcked(pool, result.frameId);

    const acked = await pool.query<{ acked_at: Date | null }>(
      "select acked_at from feed_frame where id = $1",
      [result.frameId],
    );
    expect(acked.rows[0]?.acked_at).not.toBeNull();

    const redelivered = await recordFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    expect(redelivered.alreadyRecorded).toBe(true);
    expect(redelivered.frameId).toBe(result.frameId);
  });

  it("ingestion_sequence strictly increases across separately recorded frames", async () => {
    const bodyA = JSON.stringify([
      { CT_MSG: { area_id: `${areaPrefix}C`, report_time: String(Date.now()) } },
    ]);
    const bodyB = JSON.stringify([
      { CT_MSG: { area_id: `${areaPrefix}D`, report_time: String(Date.now()) } },
    ]);

    const resultA = await recordFrame(makeFrame(bodyA), {
      pool,
      archiveClient,
      archiveBucket: bucket,
    });
    const resultB = await recordFrame(makeFrame(bodyB), {
      pool,
      archiveClient,
      archiveBucket: bucket,
    });
    createdFrameIds.push(resultA.frameId, resultB.frameId);

    const seqA = await pool.query<{ ingestion_sequence: string }>(
      "select ingestion_sequence from raw_feed_event where frame_id = $1",
      [resultA.frameId],
    );
    const seqB = await pool.query<{ ingestion_sequence: string }>(
      "select ingestion_sequence from raw_feed_event where frame_id = $1",
      [resultB.frameId],
    );
    expect(BigInt(seqB.rows[0]?.ingestion_sequence ?? "0")).toBeGreaterThan(
      BigInt(seqA.rows[0]?.ingestion_sequence ?? "0"),
    );
  });
});
