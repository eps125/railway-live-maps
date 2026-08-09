import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { resolveVstpFixturesDir } from "@railway/feed-parsers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recordVstpFrame, markVstpFrameAcked, type InboundVstpFrame } from "./recorder.js";
import { reparseVstpArchive } from "./reparseArchive.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

/** Unlike the no-op FakeS3Client used elsewhere in this suite, this one actually stores and
 * returns bytes — reparseVstpArchive reads the archived object back, so a fake that discards
 * the body would make this test meaningless. */
class ByteStoringFakeS3Client {
  private readonly objects = new Map<string, Buffer>();

  send = async (command: {
    constructor: { name: string };
    input?: { Key?: string; Body?: Buffer };
  }): Promise<unknown> => {
    const commandName = command.constructor.name;
    if (commandName === "PutObjectCommand") {
      const key = command.input?.Key;
      const body = command.input?.Body;
      if (key && body) this.objects.set(key, Buffer.from(body));
      return {};
    }
    if (commandName === "GetObjectCommand") {
      const key = command.input?.Key;
      const body = key ? this.objects.get(key) : undefined;
      if (!body) throw new Error(`ByteStoringFakeS3Client: no object at key ${String(key)}`);
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    throw new Error(`ByteStoringFakeS3Client: unhandled command ${commandName}`);
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new ByteStoringFakeS3Client() as unknown as S3Client;
const bucket = "railway-raw-test";
const fixturesDir = resolveVstpFixturesDir();

describe("reparseVstpArchive (integration)", () => {
  const createdFrameIds: string[] = [];

  afterAll(async () => {
    if (createdFrameIds.length > 0) {
      await pool.query("delete from raw_feed_event where frame_id = any($1::bigint[])", [
        createdFrameIds,
      ]);
      await pool.query("delete from feed_frame where id = any($1::bigint[])", [createdFrameIds]);
    }
    await pool.end();
  });

  it("re-derives a corrupted row from its untouched archived original", async () => {
    // Record a real frame through the current (correct) parser first — this is what puts a
    // real, retrievable copy of the bytes in the fake archive, exactly as recordBrokerFrame's
    // archive-before-ack sequence would for a live message.
    const body = await readFile(join(fixturesDir, "create-normal.json"));
    const frame: InboundVstpFrame = {
      feedName: "VSTP",
      topic: "/topic/VSTP_ALL",
      brokerMessageId: randomUUID(),
      headers: {},
      body,
      receivedAt: new Date(),
      connectionSessionId: null,
    };
    const recorded = await recordVstpFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(recorded.frameId);
    await markVstpFrameAcked(pool, recorded.frameId);

    // Now simulate exactly what the old, broken (XML-assuming) parser would have left behind —
    // corrupt the already-recorded row in place, same shape a real pre-fix ingestion produced.
    await pool.query(
      `update raw_feed_event
       set parse_status = 'malformed', event_type = 'unknown', parse_error_code = 'invalid_xml',
           raw_event_json = $2
       where frame_id = $1`,
      [recorded.frameId, JSON.stringify({ note: "body was not valid XML" })],
    );
    const corrupted = await pool.query<{ parse_status: string; event_type: string }>(
      "select parse_status, event_type from raw_feed_event where frame_id = $1",
      [recorded.frameId],
    );
    expect(corrupted.rows[0]).toEqual({ parse_status: "malformed", event_type: "unknown" });

    const summary = await reparseVstpArchive(pool, archiveClient);
    expect(summary.changed).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toBe(0);

    const fixed = await pool.query<{ parse_status: string; event_type: string }>(
      "select parse_status, event_type from raw_feed_event where frame_id = $1",
      [recorded.frameId],
    );
    expect(fixed.rows[0]).toEqual({ parse_status: "parsed", event_type: "vstp.create" });

    const frameRow = await pool.query<{ parse_status: string; parsed_child_count: number }>(
      "select parse_status, parsed_child_count from feed_frame where id = $1",
      [recorded.frameId],
    );
    expect(frameRow.rows[0]).toEqual({ parse_status: "ok", parsed_child_count: 1 });
  });

  it("dry-run reports what would change without writing anything", async () => {
    const body = await readFile(join(fixturesDir, "overwrite-normal.json"));
    const frame: InboundVstpFrame = {
      feedName: "VSTP",
      topic: "/topic/VSTP_ALL",
      brokerMessageId: randomUUID(),
      headers: {},
      body,
      receivedAt: new Date(),
      connectionSessionId: null,
    };
    const recorded = await recordVstpFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(recorded.frameId);
    await markVstpFrameAcked(pool, recorded.frameId);

    await pool.query(
      `update raw_feed_event set parse_status = 'malformed', event_type = 'unknown' where frame_id = $1`,
      [recorded.frameId],
    );

    const summary = await reparseVstpArchive(pool, archiveClient, { dryRun: true });
    expect(summary.changed).toBeGreaterThanOrEqual(1);

    // Still corrupted — dry-run must not have written anything.
    const stillCorrupted = await pool.query<{ parse_status: string }>(
      "select parse_status from raw_feed_event where frame_id = $1",
      [recorded.frameId],
    );
    expect(stillCorrupted.rows[0]?.parse_status).toBe("malformed");
  });

  it("a row that's already correctly parsed is reported unchanged, not rewritten", async () => {
    const body = await readFile(join(fixturesDir, "delete-normal.json"));
    const frame: InboundVstpFrame = {
      feedName: "VSTP",
      topic: "/topic/VSTP_ALL",
      brokerMessageId: randomUUID(),
      headers: {},
      body,
      receivedAt: new Date(),
      connectionSessionId: null,
    };
    const recorded = await recordVstpFrame(frame, { pool, archiveClient, archiveBucket: bucket });
    createdFrameIds.push(recorded.frameId);
    await markVstpFrameAcked(pool, recorded.frameId);

    const before = await pool.query<{ parse_status: string }>(
      "select parse_status from raw_feed_event where frame_id = $1",
      [recorded.frameId],
    );
    expect(before.rows[0]?.parse_status).toBe("parsed");

    const summary = await reparseVstpArchive(pool, archiveClient);
    expect(summary.errors).toBe(0);

    const after = await pool.query<{ parse_status: string }>(
      "select parse_status from raw_feed_event where frame_id = $1",
      [recorded.frameId],
    );
    expect(after.rows[0]?.parse_status).toBe("parsed");
  });
});
