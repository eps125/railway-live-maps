import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { resolveTrustFixturesDir } from "@railway/feed-parsers";
import { recordTrustFrame, markTrustFrameAcked, type InboundTrustFrame } from "./recorder.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

class FakeS3Client {
  send = async (): Promise<Record<string, never>> => {
    return {};
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new FakeS3Client() as unknown as S3Client;
const bucket = "railway-raw-test";
const fixturesDir = resolveTrustFixturesDir();

async function loadFixtureFrame(name: string): Promise<InboundTrustFrame> {
  const body = await readFile(join(fixturesDir, name));
  return {
    feedName: "TRUST",
    topic: "/topic/TRAIN_MVT_ALL_TOC",
    brokerMessageId: randomUUID(),
    headers: {},
    body,
    receivedAt: new Date(),
    connectionSessionId: null,
  };
}

describe("recordTrustFrame (integration)", () => {
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

  it("records an Activation message with a single parsed child", async () => {
    const frame = await loadFixtureFrame("activation.json");
    const result = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(result.frameId);

    expect(result.alreadyRecorded).toBe(false);
    expect(result.childCount).toBe(1);
    expect(result.parsedChildCount).toBe(1);

    const rows = await pool.query<{ event_type: string; parse_status: string }>(
      "select event_type, parse_status from raw_feed_event where frame_id = $1",
      [result.frameId],
    );
    expect(rows.rows).toEqual([{ event_type: "activation", parse_status: "parsed" }]);
  });

  it("retains an unrecognized msg_type rather than dropping it", async () => {
    const frame = await loadFixtureFrame("unsupported-msg-type.json");
    const result = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(result.frameId);

    expect(result.childCount).toBe(1);
    expect(result.unsupportedChildCount).toBe(1);
  });

  it("retains a message with a missing body as a synthetic malformed child rather than dropping it", async () => {
    const frame = await loadFixtureFrame("malformed-missing-body.json");
    const result = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(result.frameId);

    expect(result.childCount).toBe(1);
    expect(result.failedChildCount).toBe(1);
  });

  it("is idempotent under exact-byte redelivery: the second call is a safe no-op", async () => {
    const frame = await loadFixtureFrame("cancellation.json");
    const first = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(first.frameId);
    const second = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });

    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.frameId).toBe(first.frameId);
  });

  it("survives a crash-before-redelivery scenario: record after ack is still idempotent", async () => {
    const frame = await loadFixtureFrame("movement-on-time.json");
    const result = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(result.frameId);
    await markTrustFrameAcked(pool, result.frameId);

    const acked = await pool.query<{ acked_at: Date | null }>(
      "select acked_at from feed_frame where id = $1",
      [result.frameId],
    );
    expect(acked.rows[0]?.acked_at).not.toBeNull();

    const redelivered = await recordTrustFrame(frame, {
      pool,
      archiveClient,
      archiveBucket: bucket,
    });
    expect(redelivered.alreadyRecorded).toBe(true);
    expect(redelivered.frameId).toBe(result.frameId);
  });
});
