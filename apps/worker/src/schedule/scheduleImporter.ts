import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { sha256Hex, computeArchiveObjectKey, putImmutableObject } from "@railway/archive";
import {
  mapToScheduleRow,
  type ScheduleSourceRecord,
  type ScheduleSourceLocation,
} from "@railway/domain";
import { parseScheduleFileStream } from "@railway/feed-parsers";

/**
 * Milestone 7 (docs/IMPLEMENTATION_PLAN.md): imports a full SCHEDULE extract via the
 * staging-table + single-swap-transaction pattern (packages/database/migrations
 * 0013_schedule_tables.sql's `schedule_import_staging`/`schedule_location_import_staging`) —
 * "readers never see a half-imported file." The SCHEDULE JSON wire shape used here
 * (`JsonScheduleV1` — flat `CIF_train_uid`/`CIF_stp_indicator`/`schedule_segment.schedule_location[]`
 * fields, same field names as VSTP's nested `CIF_bs`) is constructed from the publicly
 * documented format, not a captured real extract — same caveat as
 * `packages/feed-parsers/src/schedule/parseScheduleFileStream.ts`.
 */
export interface ImportScheduleDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
}

export interface ImportScheduleResult {
  sourceFileImportId: string;
  /** true when this exact file content was already fully imported previously — the swap is
   * skipped entirely, so row counts are genuinely unchanged (the natural-key/checksum
   * reimport-safety acceptance bullet). */
  alreadyImported: boolean;
  scheduleRows: number;
  locationRows: number;
  unhandledRecords: number;
  malformedRecords: number;
}

const BATCH_SIZE = 500;
const VALID_STP_INDICATORS = new Set(["C", "N", "O", "P"]);

/** Adapts one `JsonScheduleV1` record into the source-agnostic `ScheduleSourceRecord` shape.
 * Returns `null` for a `transaction_type: "Delete"` record (full-extract semantics: the next
 * full extract simply omits a schedule that no longer exists — nothing to stage) or for a
 * `"schedule"`-typed record missing a required field (retained via `import_unhandled_record`
 * by the caller instead, never silently dropped). */
function extractScheduleRecord(raw: unknown): ScheduleSourceRecord | null {
  const obj = raw as Record<string, unknown>;
  if (obj.transaction_type === "Delete") {
    return null;
  }

  const trainUid = obj.CIF_train_uid;
  const scheduleStartDate = obj.schedule_start_date;
  const scheduleEndDate = obj.schedule_end_date;
  const stpIndicator = obj.CIF_stp_indicator;
  if (
    typeof trainUid !== "string" ||
    typeof scheduleStartDate !== "string" ||
    typeof scheduleEndDate !== "string" ||
    typeof stpIndicator !== "string" ||
    !VALID_STP_INDICATORS.has(stpIndicator)
  ) {
    return null;
  }

  const segment = obj.schedule_segment as Record<string, unknown> | undefined;
  const rawLocations = segment?.schedule_location;
  const locationList: Record<string, unknown>[] = Array.isArray(rawLocations)
    ? (rawLocations as Record<string, unknown>[])
    : [];

  const locations: ScheduleSourceLocation[] = locationList.map((loc) => ({
    locationType: String(loc.location_type ?? ""),
    tiploc: String(loc.tiploc_code ?? ""),
    arrivalPublic: typeof loc.public_arrival === "string" ? loc.public_arrival : null,
    arrivalWorking: typeof loc.arrival === "string" ? loc.arrival : null,
    departurePublic: typeof loc.public_departure === "string" ? loc.public_departure : null,
    departureWorking: typeof loc.departure === "string" ? loc.departure : null,
    passPublic: typeof loc.public_pass === "string" ? loc.public_pass : null,
    passWorking: typeof loc.pass === "string" ? loc.pass : null,
    platform: typeof loc.platform === "string" ? loc.platform : null,
  }));

  return {
    trainUid,
    scheduleStartDate,
    scheduleEndDate,
    stpIndicator: stpIndicator as ScheduleSourceRecord["stpIndicator"],
    daysRunsBitmask: typeof obj.schedule_days_runs === "string" ? obj.schedule_days_runs : null,
    signallingId: typeof obj.signalling_id === "string" ? obj.signalling_id : null,
    operatorCode: typeof obj.atoc_code === "string" ? obj.atoc_code : null,
    trainServiceCode:
      typeof obj.CIF_train_service_code === "string" ? obj.CIF_train_service_code : null,
    trainStatus: typeof obj.train_status === "string" ? obj.train_status : null,
    powerType: typeof obj.CIF_power_type === "string" ? obj.CIF_power_type : null,
    locations,
    source: "SCHEDULE",
    rawSourceJson: raw,
  };
}

async function findOrCreateSourceFileImport(
  pool: Pool,
  checksum: string,
  archiveObjectId: string,
): Promise<{ id: string; status: string }> {
  const existing = await pool.query<{ id: string; status: string }>(
    `select id, status from source_file_import
     where source_kind = 'schedule-file' and checksum_sha256 = $1`,
    [checksum],
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }
  const inserted = await pool.query<{ id: string; status: string }>(
    `insert into source_file_import (source_kind, file_kind, archive_object_id, checksum_sha256, status)
     values ('schedule-file', 'schedule_full', $1, $2, 'in_progress')
     returning id, status`,
    [archiveObjectId, checksum],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Expected source_file_import insert to return a row");
  }
  return row;
}

async function insertStagingBatch(
  client: PoolClient,
  stagingImportId: string,
  records: ScheduleSourceRecord[],
): Promise<void> {
  for (const record of records) {
    const mapped = mapToScheduleRow(record);
    await client.query(
      `insert into schedule_import_staging (
         staging_import_id, train_uid, schedule_start_date, schedule_end_date, stp_indicator,
         days_runs_bitmask, signalling_id, operator_code, train_service_code, train_category,
         train_status, power_type, origin_tiploc, destination_tiploc, source, raw_source_json
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        stagingImportId,
        mapped.schedule.trainUid,
        mapped.schedule.scheduleStartDate,
        mapped.schedule.scheduleEndDate,
        mapped.schedule.stpIndicator,
        mapped.schedule.daysRunsBitmask,
        mapped.schedule.signallingId,
        mapped.schedule.operatorCode,
        mapped.schedule.trainServiceCode,
        mapped.schedule.trainCategory,
        mapped.schedule.trainStatus,
        mapped.schedule.powerType,
        mapped.schedule.originTiploc,
        mapped.schedule.destinationTiploc,
        mapped.schedule.source,
        JSON.stringify(mapped.schedule.rawSourceJson),
      ],
    );
    for (const loc of mapped.locations) {
      await client.query(
        `insert into schedule_location_import_staging (
           staging_import_id, train_uid, schedule_start_date, schedule_end_date, stp_indicator,
           source, seq_no, location_type, tiploc, stanox, arrival_public, arrival_working,
           departure_public, departure_working, pass_public, pass_working, platform, path, line,
           activity_codes, raw_activity_text, day_offset
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          stagingImportId,
          mapped.schedule.trainUid,
          mapped.schedule.scheduleStartDate,
          mapped.schedule.scheduleEndDate,
          mapped.schedule.stpIndicator,
          mapped.schedule.source,
          loc.seqNo,
          loc.locationType,
          loc.tiploc,
          loc.stanox,
          loc.arrivalPublic,
          loc.arrivalWorking,
          loc.departurePublic,
          loc.departureWorking,
          loc.passPublic,
          loc.passWorking,
          loc.platform,
          loc.path,
          loc.line,
          loc.activityCodes,
          loc.rawActivityText,
          loc.dayOffset,
        ],
      );
    }
  }
}

/** Deletes any staging rows left behind by a prior crashed attempt at this same
 * source_file_import id, so a restart never sees duplicate staging rows. */
async function clearStagingRows(pool: Pool, stagingImportId: string): Promise<void> {
  await pool.query("delete from schedule_location_import_staging where staging_import_id = $1", [
    stagingImportId,
  ]);
  await pool.query("delete from schedule_import_staging where staging_import_id = $1", [
    stagingImportId,
  ]);
}

async function swapIntoRealTables(
  pool: Pool,
  sourceFileImportId: string,
  rowCounts: Record<string, number>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from schedule_location where schedule_id in (select id from schedule where source = 'SCHEDULE')`,
    );
    await client.query(`delete from schedule where source = 'SCHEDULE'`);
    await client.query(
      `insert into schedule (
         source_file_import_id, train_uid, schedule_start_date, schedule_end_date, stp_indicator,
         days_runs_bitmask, signalling_id, operator_code, train_service_code, train_category,
         train_status, power_type, origin_tiploc, destination_tiploc, source, raw_source_json
       )
       select $1, train_uid, schedule_start_date, schedule_end_date, stp_indicator,
         days_runs_bitmask, signalling_id, operator_code, train_service_code, train_category,
         train_status, power_type, origin_tiploc, destination_tiploc, source, raw_source_json
       from schedule_import_staging where staging_import_id = $1`,
      [sourceFileImportId],
    );
    await client.query(
      `insert into schedule_location (
         schedule_id, seq_no, location_type, tiploc, stanox, arrival_public, arrival_working,
         departure_public, departure_working, pass_public, pass_working, platform, path, line,
         activity_codes, raw_activity_text, day_offset
       )
       select s.id, sl.seq_no, sl.location_type, sl.tiploc, sl.stanox, sl.arrival_public,
         sl.arrival_working, sl.departure_public, sl.departure_working, sl.pass_public,
         sl.pass_working, sl.platform, sl.path, sl.line, sl.activity_codes, sl.raw_activity_text,
         sl.day_offset
       from schedule_location_import_staging sl
       join schedule s
         on s.train_uid = sl.train_uid and s.schedule_start_date = sl.schedule_start_date
        and s.schedule_end_date = sl.schedule_end_date and s.stp_indicator = sl.stp_indicator
        and s.source = sl.source and s.source_file_import_id = $1
       where sl.staging_import_id = $1`,
      [sourceFileImportId],
    );
    await client.query(
      "delete from schedule_location_import_staging where staging_import_id = $1",
      [sourceFileImportId],
    );
    await client.query("delete from schedule_import_staging where staging_import_id = $1", [
      sourceFileImportId,
    ]);
    // Only one SCHEDULE full extract is ever "current" at a time.
    await client.query(
      "update source_file_import set is_active = false where file_kind = 'schedule_full'",
    );
    await client.query(
      `update source_file_import
       set status = 'completed', completed_at = now(), is_active = true, row_counts = $2
       where id = $1`,
      [sourceFileImportId, JSON.stringify(rowCounts)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Imports a SCHEDULE full extract already saved at `filePath`. Idempotent: reimporting
 * byte-identical content short-circuits without touching the real tables again. */
export async function runImportSchedule(
  deps: ImportScheduleDeps,
  filePath: string,
): Promise<ImportScheduleResult> {
  const body = await readFile(filePath);
  const checksum = sha256Hex(body);
  const receivedAt = new Date();
  const objectKey = computeArchiveObjectKey({
    namespace: "schedule",
    contentSha256: checksum,
    date: receivedAt,
  });

  await putImmutableObject({
    client: deps.archiveClient,
    bucket: deps.archiveBucket,
    key: objectKey,
    body,
    contentType: "application/x-ndjson",
  });

  const archiveObjectId = await deps.pool
    .query<{ id: string }>(
      `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
       values ($1, $2, $3, $4, 'schedule-file')
       on conflict (object_key) do update set object_key = excluded.object_key
       returning id`,
      [objectKey, deps.archiveBucket, checksum, body.length],
    )
    .then((r) => r.rows[0]?.id);
  if (!archiveObjectId) {
    throw new Error("Failed to upsert raw_archive_object for SCHEDULE file");
  }

  const sourceFileImport = await findOrCreateSourceFileImport(deps.pool, checksum, archiveObjectId);
  if (sourceFileImport.status === "completed") {
    return {
      sourceFileImportId: sourceFileImport.id,
      alreadyImported: true,
      scheduleRows: 0,
      locationRows: 0,
      unhandledRecords: 0,
      malformedRecords: 0,
    };
  }

  await clearStagingRows(deps.pool, sourceFileImport.id);

  let scheduleRows = 0;
  let locationRows = 0;
  let unhandledRecords = 0;
  let malformedRecords = 0;
  let sawHeader = false;
  let sawTrailer = false;
  let batch: ScheduleSourceRecord[] = [];

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      await insertStagingBatch(client, sourceFileImport.id, batch);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    batch = [];
  };

  try {
    for await (const record of parseScheduleFileStream(createReadStream(filePath))) {
      if (record.recordType === "header") {
        sawHeader = true;
        continue;
      }
      if (record.recordType === "trailer") {
        sawTrailer = true;
        continue;
      }
      if (record.recordType === "schedule") {
        const extracted = extractScheduleRecord(record.raw);
        if (extracted) {
          scheduleRows += 1;
          locationRows += extracted.locations.length;
          batch.push(extracted);
          if (batch.length >= BATCH_SIZE) {
            await flushBatch();
          }
          continue;
        }
        const obj = record.raw as Record<string, unknown>;
        if (obj.transaction_type === "Delete") {
          continue; // full-extract semantics: a deleted schedule is simply omitted, not unhandled.
        }
        malformedRecords += 1;
        await deps.pool.query(
          `insert into import_unhandled_record (source_file_import_id, record_type, seq_no_in_file, raw_json)
           values ($1,'schedule',$2,$3)`,
          [sourceFileImport.id, record.seqNoInFile, JSON.stringify(record.raw)],
        );
        continue;
      }
      // tiploc / association / unknown / malformed — recognized-but-out-of-scope or genuinely
      // broken lines, all retained via import_unhandled_record (CLAUDE.md rule 18).
      unhandledRecords += 1;
      if (record.recordType === "malformed") malformedRecords += 1;
      await deps.pool.query(
        `insert into import_unhandled_record (source_file_import_id, record_type, seq_no_in_file, raw_json)
         values ($1,$2,$3,$4)`,
        [sourceFileImport.id, record.recordType, record.seqNoInFile, JSON.stringify(record.raw)],
      );
    }
    await flushBatch();
  } catch (error) {
    await deps.pool.query(
      "update source_file_import set status = 'failed', error_summary = $2 where id = $1",
      [sourceFileImport.id, (error as Error).message],
    );
    throw error;
  }

  if (!sawHeader || !sawTrailer) {
    const message = `SCHEDULE file missing ${!sawHeader ? "header" : "trailer"} record — treated as truncated/incomplete, not imported`;
    await deps.pool.query(
      "update source_file_import set status = 'failed', error_summary = $2 where id = $1",
      [sourceFileImport.id, message],
    );
    throw new Error(message);
  }

  await swapIntoRealTables(deps.pool, sourceFileImport.id, {
    scheduleRows,
    locationRows,
    unhandledRecords,
    malformedRecords,
  });

  return {
    sourceFileImportId: sourceFileImport.id,
    alreadyImported: false,
    scheduleRows,
    locationRows,
    unhandledRecords,
    malformedRecords,
  };
}
