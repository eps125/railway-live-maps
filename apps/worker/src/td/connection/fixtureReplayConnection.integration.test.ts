import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { resolveTdFixturesDir } from "@railway/feed-parsers";
import { recordFrame, markFrameAcked } from "../recorder.js";
import { FixtureReplayTdConnection } from "./fixtureReplayConnection.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

// See recorder.integration.test.ts for why S3 is faked (no MinIO in this sandbox).
class FakeS3Client {
  send = async (): Promise<Record<string, never>> => ({});
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new FakeS3Client() as unknown as S3Client;

describe("FixtureReplayTdConnection (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("replays the multi-area-smoke fixture set end-to-end with no NR_* credentials involved", async () => {
    const fixturesDir = resolveTdFixturesDir();
    const fixturePaths = [
      "frame-zz-c-class-sequence.json",
      "frame-zy-c-class-sequence.json",
      "frame-zz-s-class.json",
      "frame-unknown-type.json",
      "frame-malformed-child.json",
      "frame-corrupt-body.json",
    ].map((name) => join(fixturesDir, name));

    const frameIds: string[] = [];
    const connection = new FixtureReplayTdConnection({ fixturePaths });

    let sessionRowId: string | undefined;
    await connection.start({
      onSessionStart: async (session) => {
        const result = await pool.query<{ id: string }>(
          `insert into feed_connection_session (feed_name, client_id, connected_at)
           values ('TD', $1, $2) returning id`,
          [session.clientId, session.connectedAt],
        );
        sessionRowId = result.rows[0]?.id;
        return sessionRowId ?? "";
      },
      onSessionEnd: async (info) => {
        await pool.query(
          "update feed_connection_session set disconnected_at = $2, disconnect_reason = $3 where id = $1",
          [info.sessionId, info.at, info.disconnectReason],
        );
      },
      onFrame: async (handle) => {
        const result = await recordFrame(handle.frame, {
          pool,
          archiveClient,
          archiveBucket: "railway-raw-test",
        });
        await markFrameAcked(pool, result.frameId);
        await handle.ack();
        frameIds.push(result.frameId);
      },
    });

    expect(frameIds).toHaveLength(6);
    expect(process.env.NR_USERNAME).toBeUndefined();
    expect(process.env.NR_PASSWORD).toBeUndefined();

    const totalChildren = await pool.query<{ n: string }>(
      "select count(*) as n from raw_feed_event where frame_id = any($1::bigint[])",
      [frameIds],
    );
    // 4 (CA/CC/CB/CT) + 1 (CA) + 1 (S-Class) + 1 (unsupported) + 2 (1 parsed + 1 malformed) + 1 (synthetic malformed) = 10
    expect(Number(totalChildren.rows[0]?.n ?? "0")).toBe(10);

    const sessionRow = await pool.query<{ disconnected_at: Date | null }>(
      "select disconnected_at from feed_connection_session where id = $1",
      [sessionRowId],
    );
    expect(sessionRow.rows[0]?.disconnected_at).not.toBeNull();

    // Cleanup — this test's data is isolated by the fresh frame ids collected above.
    await pool.query("delete from raw_feed_event where frame_id = any($1::bigint[])", [frameIds]);
    await pool.query("delete from feed_frame where id = any($1::bigint[])", [frameIds]);
    if (sessionRowId) {
      await pool.query("delete from feed_connection_session where id = $1", [sessionRowId]);
    }
  });

  it("redelivery-smoke: a repeated fixture is recorded once, not twice", async () => {
    const fixturesDir = resolveTdFixturesDir();
    // Use a unique-content fixture pair by relying on frame-zy (distinct from the test above)
    // repeated twice, plus one more, to prove redelivery within a replay run.
    const fixturePaths = [
      join(fixturesDir, "frame-zy-c-class-sequence.json"),
      join(fixturesDir, "frame-zy-c-class-sequence.json"),
    ];

    const frameIds: string[] = [];
    let alreadyRecordedCount = 0;
    const connection = new FixtureReplayTdConnection({ fixturePaths });

    let sessionRowId: string | undefined;
    await connection.start({
      onSessionStart: async (session) => {
        const result = await pool.query<{ id: string }>(
          `insert into feed_connection_session (feed_name, client_id, connected_at)
           values ('TD', $1, $2) returning id`,
          [session.clientId, session.connectedAt],
        );
        sessionRowId = result.rows[0]?.id;
        return sessionRowId ?? "";
      },
      onSessionEnd: async () => {},
      onFrame: async (handle) => {
        const result = await recordFrame(handle.frame, {
          pool,
          archiveClient,
          archiveBucket: "railway-raw-test",
        });
        await markFrameAcked(pool, result.frameId);
        await handle.ack();
        frameIds.push(result.frameId);
        if (result.alreadyRecorded) alreadyRecordedCount += 1;
      },
    });

    expect(new Set(frameIds).size).toBe(1);
    expect(alreadyRecordedCount).toBe(1);

    await pool.query("delete from raw_feed_event where frame_id = any($1::bigint[])", [frameIds]);
    await pool.query("delete from feed_frame where id = any($1::bigint[])", [frameIds]);
    if (sessionRowId) {
      await pool.query("delete from feed_connection_session where id = $1", [sessionRowId]);
    }
  });
});
