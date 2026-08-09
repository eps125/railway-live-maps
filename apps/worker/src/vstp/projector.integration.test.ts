import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { resolveVstpFixturesDir } from "@railway/feed-parsers";
import { recordVstpFrame, markVstpFrameAcked, type InboundVstpFrame } from "./recorder.js";
import { runProjectVstp } from "./projector.js";

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
const fixturesDir = resolveVstpFixturesDir();

// The fixtures under test all share this synthetic train_uid (see parseVstpFrame.ts's own doc
// comment for how the real wire shape these fixtures follow was confirmed).
const TRAIN_UID = "ZZ12345";

// Recorded frame ids, cleaned up in afterAll — these fixtures have fixed content (unlike TD's
// tests, which randomize their area per test), so a fixed body_hash would otherwise leak across
// separate test runs and make recordVstpFrame see a false "already recorded" in a later run
// (e.g. recorder.integration.test.ts's own Create-fixture test).
const recordedFrameIds: string[] = [];

async function recordFixture(name: string): Promise<void> {
  const body = await readFile(join(fixturesDir, name));
  const frame: InboundVstpFrame = {
    feedName: "VSTP",
    topic: "/topic/VSTP_ALL",
    brokerMessageId: randomUUID(),
    headers: {},
    body,
    receivedAt: new Date(),
    connectionSessionId: null,
  };
  const result = await recordVstpFrame(frame, { pool, archiveClient, archiveBucket: bucket });
  if (!result.alreadyRecorded) {
    recordedFrameIds.push(result.frameId);
  }
  await markVstpFrameAcked(pool, result.frameId);
}

interface ScheduleRow {
  id: string;
  stp_indicator: string;
  origin_tiploc: string | null;
  destination_tiploc: string | null;
}

async function schedulesFor(trainUid: string): Promise<ScheduleRow[]> {
  const result = await pool.query<ScheduleRow>(
    `select id, stp_indicator, origin_tiploc, destination_tiploc from schedule
     where train_uid = $1 and source = 'VSTP' order by stp_indicator`,
    [trainUid],
  );
  return result.rows;
}

async function locationCount(scheduleId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "select count(*)::int as n from schedule_location where schedule_id = $1",
    [scheduleId],
  );
  return result.rows[0]?.n ?? 0;
}

describe("runProjectVstp (integration)", () => {
  afterAll(async () => {
    await pool.query("delete from schedule where train_uid = $1 and source = 'VSTP'", [TRAIN_UID]);
    if (recordedFrameIds.length > 0) {
      await pool.query("delete from raw_feed_event where frame_id = any($1::bigint[])", [
        recordedFrameIds,
      ]);
      await pool.query("delete from feed_frame where id = any($1::bigint[])", [recordedFrameIds]);
    }
    await pool.end();
  });

  it("Create inserts a new schedule row with its locations", async () => {
    await recordFixture("create-normal.json");
    await runProjectVstp(pool);

    const rows = await schedulesFor(TRAIN_UID);
    const created = rows.find((r) => r.stp_indicator === "N");
    expect(created).toMatchObject({ origin_tiploc: "PRST", destination_tiploc: "LANCSTR" });
    expect(await locationCount(created!.id)).toBe(2);
  });

  it("Overwrite upserts a distinct schedule row under its own STP indicator", async () => {
    await recordFixture("overwrite-normal.json");
    await runProjectVstp(pool);

    const rows = await schedulesFor(TRAIN_UID);
    const created = rows.find((r) => r.stp_indicator === "N");
    const overwritten = rows.find((r) => r.stp_indicator === "O");
    expect(created).toBeDefined(); // the earlier Create's row is untouched by the Overwrite.
    expect(overwritten).toMatchObject({ origin_tiploc: "PRST", destination_tiploc: "LANCSTR" });
    expect(await locationCount(overwritten!.id)).toBe(2);
  });

  it("Update upserts the matching schedule row exactly like Overwrite would (real, undocumented transaction type)", async () => {
    await recordFixture("update-normal.json");
    await runProjectVstp(pool);

    const rows = await schedulesFor(TRAIN_UID);
    const updated = rows.find((r) => r.stp_indicator === "N");
    expect(updated).toMatchObject({ origin_tiploc: "PRST", destination_tiploc: "LANCSTR" });
    expect(await locationCount(updated!.id)).toBe(2);

    // Confirms this actually re-applied the schedule (not a no-op) — update-normal.json's
    // origin departure time (1208) differs from create-normal.json's (1200) for the same
    // train_uid/dates/stp_indicator "N".
    const location = await pool.query<{ departure_public: string | null }>(
      `select departure_public from schedule_location
       where schedule_id = $1 and location_type = 'origin'`,
      [updated!.id],
    );
    expect(location.rows[0]?.departure_public).toBe("1208");
  });

  it("Delete removes the matching schedule row without touching other STP indicators", async () => {
    await recordFixture("delete-normal.json");
    await runProjectVstp(pool);

    const rows = await schedulesFor(TRAIN_UID);
    expect(rows.find((r) => r.stp_indicator === "O")).toBeUndefined();
    expect(rows.find((r) => r.stp_indicator === "N")).toBeDefined();
  });

  it("redelivering an already-projected frame is a safe no-op (idempotent replay)", async () => {
    const before = await schedulesFor(TRAIN_UID);

    // Rewind the shared checkpoint and reprocess the whole VSTP backlog — mirrors the TD
    // projector's own restart/replay test.
    await pool.query(
      `update projection_checkpoint set last_ingestion_sequence = 0
       where projection_definition_id = (
         select id from projection_definition where name = 'vstp-schedule'
       )`,
    );
    await runProjectVstp(pool);

    const after = await schedulesFor(TRAIN_UID);
    expect(after).toEqual(before);
  });
});
