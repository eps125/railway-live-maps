import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { sha256Hex } from "@railway/archive";
import { resolveScheduleFixturesDir } from "@railway/feed-parsers";
import { runImportSchedule } from "./scheduleImporter.js";

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
const fixturesDir = resolveScheduleFixturesDir();
const deps = { pool, archiveClient, archiveBucket: bucket };

async function resetFixtureState(fileName: string): Promise<void> {
  const body = await readFile(join(fixturesDir, fileName));
  const checksum = sha256Hex(body);
  const existing = await pool.query<{ id: string; archive_object_id: string }>(
    `select id, archive_object_id from source_file_import
     where source_kind = 'schedule-file' and checksum_sha256 = $1`,
    [checksum],
  );
  for (const row of existing.rows) {
    await pool.query("delete from import_unhandled_record where source_file_import_id = $1", [
      row.id,
    ]);
    await pool.query("delete from schedule_location_import_staging where staging_import_id = $1", [
      row.id,
    ]);
    await pool.query("delete from schedule_import_staging where staging_import_id = $1", [row.id]);
    await pool.query("delete from source_file_import where id = $1", [row.id]);
    await pool.query("delete from raw_archive_object where id = $1", [row.archive_object_id]);
  }
}

async function scheduleRowsFor(
  trainUid: string,
): Promise<
  { stp_indicator: string; origin_tiploc: string | null; destination_tiploc: string | null }[]
> {
  const result = await pool.query<{
    stp_indicator: string;
    origin_tiploc: string | null;
    destination_tiploc: string | null;
  }>(
    `select stp_indicator, origin_tiploc, destination_tiploc from schedule
     where train_uid = $1 and source = 'SCHEDULE' order by stp_indicator`,
    [trainUid],
  );
  return result.rows;
}

async function scheduleDetailFor(
  trainUid: string,
  stpIndicator: string,
): Promise<
  | {
      id: string;
      signallingId: string | null;
      trainCategory: string | null;
      powerType: string | null;
    }
  | undefined
> {
  const result = await pool.query<{
    id: string;
    signalling_id: string | null;
    train_category: string | null;
    power_type: string | null;
  }>(
    `select id, signalling_id, train_category, power_type from schedule
     where train_uid = $1 and stp_indicator = $2 and source = 'SCHEDULE'`,
    [trainUid, stpIndicator],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        signallingId: row.signalling_id,
        trainCategory: row.train_category,
        powerType: row.power_type,
      }
    : undefined;
}

async function locationDeparturesFor(scheduleId: string): Promise<(string | null)[]> {
  const result = await pool.query<{ departure_public: string | null }>(
    `select departure_public from schedule_location where schedule_id = $1 order by seq_no`,
    [scheduleId],
  );
  return result.rows.map((r) => r.departure_public);
}

describe("runImportSchedule (integration)", () => {
  beforeAll(async () => {
    await resetFixtureState("full-extract-small.jsonl");
    await resetFixtureState("full-extract-week2.jsonl");
    await resetFixtureState("malformed-line.jsonl");
    await resetFixtureState("unsupported-record-type.jsonl");
    await pool.query(
      "delete from schedule where train_uid in ('ZZ54321', 'ZZ99999', 'ZZ11111', 'ZZ22222')",
    );
  });

  afterAll(async () => {
    await pool.query(
      "delete from schedule where train_uid in ('ZZ54321', 'ZZ99999', 'ZZ11111', 'ZZ22222')",
    );
    await pool.end();
  });

  it("imports schedule rows, skips a Delete transaction, and retains tiploc/association as unhandled", async () => {
    const filePath = join(fixturesDir, "full-extract-small.jsonl");
    const result = await runImportSchedule(deps, filePath);

    expect(result.alreadyImported).toBe(false);
    expect(result.scheduleRows).toBe(3); // ZZ54321 P, ZZ54321 O, ZZ99999 N — the Delete record is excluded.
    expect(result.unhandledRecords).toBe(2); // TiplocV1 + AssociationV1.
    expect(result.malformedRecords).toBe(0);

    const zz54321 = await scheduleRowsFor("ZZ54321");
    expect(zz54321.map((r) => r.stp_indicator)).toEqual(["O", "P"]);
    expect(zz54321[0]).toMatchObject({ origin_tiploc: "PRST", destination_tiploc: "LANCSTR" });

    const zz99999 = await scheduleRowsFor("ZZ99999");
    expect(zz99999).toHaveLength(1);

    // signalling_id/CIF_train_category/CIF_power_type all live inside schedule_segment on the
    // real wire, not on the record itself — confirmed against a real extract 2026-08-10. This
    // fixture's ZZ54321 P record carries all three there.
    const zz54321P = await scheduleDetailFor("ZZ54321", "P");
    expect(zz54321P).toMatchObject({
      signallingId: "2A16",
      trainCategory: "XX",
      powerType: "EMU",
    });
  });

  it("a later full extract updates in place (same row id) and never deletes a schedule simply absent from it", async () => {
    const zz54321Before = await scheduleDetailFor("ZZ54321", "P");
    const zz99999Before = await scheduleDetailFor("ZZ99999", "N");
    if (!zz54321Before || !zz99999Before)
      throw new Error("expected prior test to have imported these");

    const result = await runImportSchedule(deps, join(fixturesDir, "full-extract-week2.jsonl"));
    expect(result.alreadyImported).toBe(false);
    expect(result.scheduleRows).toBe(2); // ZZ99999 N (updated) + ZZ22222 P (new).

    // ZZ54321 isn't in week2's file at all — still there, untouched (historical retention, not
    // an FK-violating delete-and-reinsert).
    const zz54321After = await scheduleDetailFor("ZZ54321", "P");
    expect(zz54321After).toEqual(zz54321Before);
    const zz54321Rows = await scheduleRowsFor("ZZ54321");
    expect(zz54321Rows.map((r) => r.stp_indicator)).toEqual(["O", "P"]);

    // ZZ99999 N reappears with different content — same row id (proves in-place update, not a
    // new row breaking any existing FK into the old one), new signalling_id and locations.
    const zz99999After = await scheduleDetailFor("ZZ99999", "N");
    expect(zz99999After?.id).toBe(zz99999Before.id);
    expect(zz99999After?.signallingId).toBe("5Z09");
    expect(await locationDeparturesFor(zz99999After!.id)).toEqual(["1415", null]);

    // A genuinely new schedule in week2 still gets inserted normally.
    const zz22222 = await scheduleDetailFor("ZZ22222", "P");
    expect(zz22222?.signallingId).toBe("2A20");
  });

  it("reimporting byte-identical content is a safe no-op (natural-key/checksum idempotency)", async () => {
    const filePath = join(fixturesDir, "full-extract-small.jsonl");
    const before = await scheduleRowsFor("ZZ54321");

    const second = await runImportSchedule(deps, filePath);
    expect(second.alreadyImported).toBe(true);

    const after = await scheduleRowsFor("ZZ54321");
    expect(after).toEqual(before);
  });

  it("retains a malformed line via import_unhandled_record rather than failing the whole import", async () => {
    const filePath = join(fixturesDir, "malformed-line.jsonl");
    const result = await runImportSchedule(deps, filePath);

    expect(result.alreadyImported).toBe(false);
    expect(result.scheduleRows).toBe(1);
    expect(result.malformedRecords).toBe(1);

    const unhandled = await pool.query<{ record_type: string }>(
      `select record_type from import_unhandled_record where source_file_import_id = $1`,
      [result.sourceFileImportId],
    );
    expect(unhandled.rows.map((r) => r.record_type)).toEqual(["malformed"]);
  });

  it("retains an unrecognized record type via import_unhandled_record, never dropped", async () => {
    const filePath = join(fixturesDir, "unsupported-record-type.jsonl");
    const result = await runImportSchedule(deps, filePath);

    expect(result.scheduleRows).toBe(0);
    expect(result.unhandledRecords).toBe(1);

    const unhandled = await pool.query<{ record_type: string }>(
      `select record_type from import_unhandled_record where source_file_import_id = $1`,
      [result.sourceFileImportId],
    );
    expect(unhandled.rows).toEqual([{ record_type: "unknown" }]);
  });
});
