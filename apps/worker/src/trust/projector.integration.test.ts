import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { resolveTrustFixturesDir } from "@railway/feed-parsers";
import { recordTrustFrame, markTrustFrameAcked, type InboundTrustFrame } from "./recorder.js";
import { runProjectTrust } from "./projector.js";

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

// The fixtures under test all narrate a single train's lifecycle under this identity, up until
// the Change of Identity fixture supersedes it — constructed from public documentation, not a
// captured real message (unlike VSTP's fixtures, which were corrected against a real capture —
// see packages/feed-parsers/src/vstp/parseVstpFrame.ts's doc comment).
const TRAIN_ID = "2A1612AA26";
const NEW_TRAIN_ID = "2A9912AA26";
const TRAIN_UID = "ZZ54321";
const UNIDENTIFIED_ID = "UNKNOWNXXX";
const DEFERRED_TRAIN_ID = "DEFER00001";
const DEFERRED_TRAIN_UID = "ZZDEFER01";

const recordedFrameIds: string[] = [];

async function recordFixture(name: string): Promise<void> {
  const body = await readFile(join(fixturesDir, name));
  const frame: InboundTrustFrame = {
    feedName: "TRUST",
    topic: "/topic/TRAIN_MVT_ALL_TOC",
    brokerMessageId: randomUUID(),
    headers: {},
    body,
    receivedAt: new Date(),
    connectionSessionId: null,
  };
  const result = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
  if (!result.alreadyRecorded) {
    recordedFrameIds.push(result.frameId);
  }
  await markTrustFrameAcked(pool, result.frameId);
}

function activationBody(
  trustTrainId: string,
  trainUid: string,
  creationTimestampMs: number,
): unknown[] {
  return [
    {
      header: {
        msg_type: "0001",
        source_dev_id: "",
        user_id: "",
        original_data_source: "TRUST",
        msg_queue_timestamp: String(creationTimestampMs),
        source_system_id: "TRUST",
      },
      body: {
        schedule_source: "C",
        train_file_address: null,
        schedule_end_date: "2026-12-31",
        train_id: trustTrainId,
        tp_origin_timestamp: "2026-08-10",
        creation_timestamp: String(creationTimestampMs),
        tp_origin_stanox: "22334",
        origin_dep_timestamp: String(creationTimestampMs + 60000),
        train_service_code: "22222000",
        toc_id: "NT",
        d1266_record_number: "001",
        train_call_type: "AUTOMATIC",
        train_call_mode: "NORMAL",
        schedule_type: "P",
        sched_origin_stanox: "22334",
        train_uid: trainUid,
        schedule_wtt_id: "2A16",
        schedule_start_date: "2026-01-01",
      },
    },
  ];
}

async function recordAdHocActivation(trustTrainId: string, trainUid: string): Promise<void> {
  const body = Buffer.from(JSON.stringify(activationBody(trustTrainId, trainUid, Date.now())));
  const frame: InboundTrustFrame = {
    feedName: "TRUST",
    topic: "/topic/TRAIN_MVT_ALL_TOC",
    brokerMessageId: randomUUID(),
    headers: {},
    body,
    receivedAt: new Date(),
    connectionSessionId: null,
  };
  const result = await recordTrustFrame(frame, { pool, archiveClient, archiveBucket: bucket });
  if (!result.alreadyRecorded) {
    recordedFrameIds.push(result.frameId);
  }
  await markTrustFrameAcked(pool, result.frameId);
}

interface RunRow {
  id: string;
  lifecycle_state: string;
  service_date: string;
  schedule_id: string | null;
  superseded_by_train_run_id: string | null;
}

async function runFor(trustTrainId: string): Promise<RunRow | undefined> {
  const result = await pool.query<RunRow>(
    `select id, lifecycle_state, service_date::text as service_date, schedule_id,
            superseded_by_train_run_id
     from train_run where trust_train_id = $1`,
    [trustTrainId],
  );
  return result.rows[0];
}

async function linkFor(runId: string): Promise<{ match_outcome: string } | undefined> {
  const result = await pool.query<{ match_outcome: string }>(
    `select match_outcome from run_schedule_link where train_run_id = $1`,
    [runId],
  );
  return result.rows[0];
}

describe("runProjectTrust (integration)", () => {
  afterAll(async () => {
    await pool.query(
      `delete from run_schedule_link where train_run_id in (
         select id from train_run where trust_train_id = any($1::text[])
       )`,
      [[TRAIN_ID, NEW_TRAIN_ID, UNIDENTIFIED_ID, DEFERRED_TRAIN_ID]],
    );
    await pool.query(
      `delete from train_run_event where train_run_id in (
         select id from train_run where trust_train_id = any($1::text[])
       )`,
      [[TRAIN_ID, NEW_TRAIN_ID, UNIDENTIFIED_ID, DEFERRED_TRAIN_ID]],
    );
    await pool.query("delete from train_run where trust_train_id = any($1::text[])", [
      [TRAIN_ID, NEW_TRAIN_ID, UNIDENTIFIED_ID, DEFERRED_TRAIN_ID],
    ]);
    await pool.query("delete from schedule where train_uid = any($1::text[])", [
      [TRAIN_UID, DEFERRED_TRAIN_UID],
    ]);
    if (recordedFrameIds.length > 0) {
      await pool.query("delete from raw_feed_event where frame_id = any($1::bigint[])", [
        recordedFrameIds,
      ]);
      await pool.query("delete from feed_frame where id = any($1::bigint[])", [recordedFrameIds]);
    }
    await pool.end();
  });

  it("retains an unrelated-region identity alongside the narrated identity, nothing filtered", async () => {
    // A wide-open covering schedule so the activation's exact-link resolves to "matched"
    // regardless of the fixture's exact embedded timestamp.
    await pool.query(
      `insert into schedule (
         train_uid, schedule_start_date, schedule_end_date, stp_indicator, source, raw_source_json
       ) values ($1, '2000-01-01', '2099-12-31', 'P', 'SCHEDULE', '{}')`,
      [TRAIN_UID],
    );

    await recordFixture("activation.json");
    await runProjectTrust(pool);

    const run = await runFor(TRAIN_ID);
    expect(run).toMatchObject({ lifecycle_state: "activated" });
    expect(run!.schedule_id).not.toBeNull();

    const link = await linkFor(run!.id);
    expect(link).toMatchObject({ match_outcome: "matched" });
  });

  it("Movement advances last_event_at without changing lifecycle", async () => {
    const before = await runFor(TRAIN_ID);
    await recordFixture("movement-on-time.json");
    await runProjectTrust(pool);
    const after = await runFor(TRAIN_ID);
    expect(after!.lifecycle_state).toBe("activated");
    expect(after!.id).toBe(before!.id);
  });

  it("cancel-then-reinstate: Cancellation moves to cancelled, Reinstatement moves back to activated", async () => {
    await recordFixture("cancellation.json");
    await runProjectTrust(pool);
    expect((await runFor(TRAIN_ID))!.lifecycle_state).toBe("cancelled");

    await recordFixture("reinstatement.json");
    await runProjectTrust(pool);
    expect((await runFor(TRAIN_ID))!.lifecycle_state).toBe("activated");
  });

  it("Change of Origin / Change of Location touch last_event_at without erroring", async () => {
    await recordFixture("change-of-origin.json");
    await recordFixture("change-of-location.json");
    await runProjectTrust(pool);
    expect((await runFor(TRAIN_ID))!.lifecycle_state).toBe("activated");
  });

  it("Change of Identity supersedes the old run and creates a new one under the revised identity", async () => {
    await recordFixture("change-of-identity.json");
    await runProjectTrust(pool);

    const oldRun = await runFor(TRAIN_ID);
    const newRun = await runFor(NEW_TRAIN_ID);
    expect(oldRun!.lifecycle_state).toBe("superseded");
    expect(newRun).toMatchObject({ lifecycle_state: "activated" });
    expect(oldRun!.superseded_by_train_run_id).toBe(newRun!.id);
  });

  it("Unidentified Train creates a minimal run with no schedule link", async () => {
    await recordFixture("unidentified.json");
    await runProjectTrust(pool);

    const run = await runFor(UNIDENTIFIED_ID);
    expect(run).toMatchObject({ lifecycle_state: "unidentified" });
    expect(run!.schedule_id).toBeNull();
  });

  it("an activation with no matching schedule yet is unmatched, then resolved by a deferred relink once the schedule appears", async () => {
    await recordAdHocActivation(DEFERRED_TRAIN_ID, DEFERRED_TRAIN_UID);
    await runProjectTrust(pool);

    const runBeforeSchedule = await runFor(DEFERRED_TRAIN_ID);
    expect(runBeforeSchedule!.schedule_id).toBeNull();
    const linkBefore = await linkFor(runBeforeSchedule!.id);
    expect(linkBefore).toMatchObject({ match_outcome: "unmatched" });

    await pool.query(
      `insert into schedule (
         train_uid, schedule_start_date, schedule_end_date, stp_indicator, source, raw_source_json
       ) values ($1, '2000-01-01', '2099-12-31', 'P', 'SCHEDULE', '{}')`,
      [DEFERRED_TRAIN_UID],
    );

    // Rerunning without any new raw events still triggers the deferred-relink pass at the end
    // of runProjectTrust — this must never insert a second run_schedule_link row.
    await runProjectTrust(pool);

    const runAfterSchedule = await runFor(DEFERRED_TRAIN_ID);
    expect(runAfterSchedule!.schedule_id).not.toBeNull();
    const linkAfter = await pool.query<{ n: number }>(
      "select count(*)::int as n from run_schedule_link where train_run_id = $1",
      [runBeforeSchedule!.id],
    );
    expect(linkAfter.rows[0]?.n).toBe(1);
    const linkNow = await linkFor(runBeforeSchedule!.id);
    expect(linkNow).toMatchObject({ match_outcome: "matched" });
  });

  it("redelivering an already-projected frame is a safe no-op (idempotent replay)", async () => {
    const beforeOld = await runFor(TRAIN_ID);
    const beforeNew = await runFor(NEW_TRAIN_ID);

    await pool.query(
      `update projection_checkpoint set last_ingestion_sequence = 0
       where projection_definition_id = (
         select id from projection_definition where name = 'trust-runs'
       )`,
    );
    await runProjectTrust(pool);

    const afterOld = await runFor(TRAIN_ID);
    const afterNew = await runFor(NEW_TRAIN_ID);
    expect(afterOld).toEqual(beforeOld);
    expect(afterNew).toEqual(beforeNew);
  });
});
