import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  resetCheckpoint,
} from "@railway/database";
import {
  mapToScheduleRow,
  VSTP_NORMALIZATION_VERSION,
  VSTP_PROJECTION_NAME,
  VSTP_PROJECTION_VERSION,
  type ScheduleSourceRecord,
  type ScheduleSourceLocation,
} from "@railway/domain";

export { VSTP_PROJECTION_NAME, VSTP_PROJECTION_VERSION };

const DEFAULT_BATCH_SIZE = 500;
const VALID_STP_INDICATORS = new Set(["C", "N", "O", "P"]);

export interface ProjectVstpOptions {
  batchSize?: number;
  /** Clears this projection version's schedule/schedule_location rows (source='VSTP' only —
   * SCHEDULE-imported rows are untouched) and reprocesses from ingestion_sequence 0. */
  rebuild?: boolean;
}

export interface ProjectVstpSummary {
  batches: number;
  processedEvents: number;
  applied: number;
  deleted: number;
  skippedInvalid: number;
}

interface RawVstpRow {
  id: string;
  normalized_event_at_utc: Date;
  ingestion_sequence: string;
  event_type: string;
  raw_event_json: Record<string, unknown>;
  parse_status: string;
}

function computeConfigHash(): string {
  return createHash("sha256")
    .update(`vstp-projection-v${VSTP_PROJECTION_VERSION}-norm-v${VSTP_NORMALIZATION_VERSION}`)
    .digest("hex");
}

async function clearProjectionRows(pool: Pool): Promise<void> {
  // schedule_location cascades on schedule delete (migration 0013's `on delete cascade`).
  await pool.query(`delete from schedule where source = 'VSTP'`);
}

/**
 * Adapts the raw VSTP XML-derived JSON (see `parseVstpFrame.ts`'s doc comment: root
 * `VSTPCIFMsgV1.schedule`, constructed from public documentation, not a captured real message)
 * into the source-agnostic `ScheduleSourceRecord` shape `mapToScheduleRow` expects. Returns
 * `null` when a required field is missing/unrecognized — the raw event itself is still retained
 * untouched in `raw_feed_event`, only its projection into `schedule` is skipped.
 */
function extractScheduleSourceRecord(rawEventJson: unknown): ScheduleSourceRecord | null {
  const root = rawEventJson as Record<string, unknown>;
  const msg = root?.VSTPCIFMsgV1 as Record<string, unknown> | undefined;
  const schedule = msg?.schedule as Record<string, unknown> | undefined;
  if (!schedule) return null;

  const cifBs = schedule.CIF_bs as Record<string, unknown> | undefined;
  if (!cifBs) return null;

  const trainUid = cifBs.CIF_train_uid;
  const scheduleStartDate = cifBs.schedule_start_date;
  const scheduleEndDate = cifBs.schedule_end_date;
  const stpIndicator = cifBs.CIF_stp_indicator;
  if (
    typeof trainUid !== "string" ||
    typeof scheduleStartDate !== "string" ||
    typeof scheduleEndDate !== "string" ||
    typeof stpIndicator !== "string" ||
    !VALID_STP_INDICATORS.has(stpIndicator)
  ) {
    return null;
  }

  const segment = schedule.schedule_segment as Record<string, unknown> | undefined;
  const rawLocations = segment?.schedule_location;
  // fast-xml-parser only produces an array when 2+ sibling elements are present — a single
  // <schedule_location> parses as a bare object, so it's normalized to a one-element array here.
  const locationList: Record<string, unknown>[] = Array.isArray(rawLocations)
    ? (rawLocations as Record<string, unknown>[])
    : rawLocations
      ? [rawLocations as Record<string, unknown>]
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
    daysRunsBitmask: typeof cifBs.schedule_days_runs === "string" ? cifBs.schedule_days_runs : null,
    signallingId: typeof cifBs.signalling_id === "string" ? cifBs.signalling_id : null,
    operatorCode: typeof cifBs.atoc_code === "string" ? cifBs.atoc_code : null,
    trainStatus: typeof cifBs.train_status === "string" ? cifBs.train_status : null,
    locations,
    source: "VSTP",
    rawSourceJson: rawEventJson,
  };
}

async function applyCreateOrOverwrite(
  client: PoolClient,
  record: ScheduleSourceRecord,
): Promise<void> {
  const mapped = mapToScheduleRow(record);
  const upserted = await client.query<{ id: string }>(
    `insert into schedule (
       train_uid, schedule_start_date, schedule_end_date, stp_indicator, days_runs_bitmask,
       signalling_id, operator_code, train_service_code, train_category, train_status, power_type,
       origin_tiploc, destination_tiploc, source, raw_source_json
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (train_uid, schedule_start_date, schedule_end_date, stp_indicator, source) do update
     set days_runs_bitmask = excluded.days_runs_bitmask, signalling_id = excluded.signalling_id,
         operator_code = excluded.operator_code, train_service_code = excluded.train_service_code,
         train_category = excluded.train_category, train_status = excluded.train_status,
         power_type = excluded.power_type, origin_tiploc = excluded.origin_tiploc,
         destination_tiploc = excluded.destination_tiploc, raw_source_json = excluded.raw_source_json,
         updated_at = now()
     returning id`,
    [
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
  const scheduleId = upserted.rows[0]?.id;
  if (!scheduleId) {
    throw new Error("Expected schedule upsert to return an id");
  }

  // VSTP is incremental (no staging/swap): replace this schedule's locations wholesale rather
  // than diffing, since an Overwrite always supplies the complete new location list.
  await client.query(`delete from schedule_location where schedule_id = $1`, [scheduleId]);
  for (const loc of mapped.locations) {
    await client.query(
      `insert into schedule_location (
         schedule_id, seq_no, location_type, tiploc, stanox, arrival_public, arrival_working,
         departure_public, departure_working, pass_public, pass_working, platform, path, line,
         activity_codes, raw_activity_text, day_offset
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        scheduleId,
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

async function applyDelete(client: PoolClient, record: ScheduleSourceRecord): Promise<boolean> {
  const result = await client.query(
    `delete from schedule
     where train_uid = $1 and schedule_start_date = $2 and schedule_end_date = $3
       and stp_indicator = $4 and source = 'VSTP'`,
    [record.trainUid, record.scheduleStartDate, record.scheduleEndDate, record.stpIndicator],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Projects nationwide VSTP schedule-transaction events into the shared `schedule`/
 * `schedule_location` tables (docs/IMPLEMENTATION_PLAN.md Milestone 7). Unlike the TD/TRUST
 * projectors, VSTP has no separate "current state" table to maintain beyond `schedule` itself —
 * Create/Overwrite upsert by natural key, Delete removes the matching row. Processes strictly in
 * `ingestion_sequence` order so redelivery/replay is idempotent and safe to restart.
 */
export async function runProjectVstp(
  pool: Pool,
  options: ProjectVstpOptions = {},
): Promise<ProjectVstpSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const definitionId = await getOrCreateProjectionDefinition(
    pool,
    VSTP_PROJECTION_NAME,
    VSTP_PROJECTION_VERSION,
    computeConfigHash(),
  );
  await ensureCheckpoint(pool, definitionId);

  if (options.rebuild) {
    await clearProjectionRows(pool);
    await resetCheckpoint(pool, definitionId);
  }

  const summary: ProjectVstpSummary = {
    batches: 0,
    processedEvents: 0,
    applied: 0,
    deleted: 0,
    skippedInvalid: 0,
  };

  for (;;) {
    const checkpoint = await getCheckpoint(pool, definitionId);
    const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

    const batch = await pool.query<RawVstpRow>(
      `select id, normalized_event_at_utc, ingestion_sequence, event_type, raw_event_json, parse_status
       from raw_feed_event
       where feed_name = 'VSTP' and ingestion_sequence > $1
       order by ingestion_sequence
       limit $2`,
      [lastSequence, batchSize],
    );
    if (batch.rows.length === 0) {
      break;
    }
    summary.batches += 1;

    const client = await pool.connect();
    try {
      await client.query("begin");
      let maxSequence = BigInt(lastSequence);

      for (const row of batch.rows) {
        summary.processedEvents += 1;
        const rowSequence = BigInt(row.ingestion_sequence);
        if (rowSequence > maxSequence) {
          maxSequence = rowSequence;
        }

        if (
          row.parse_status !== "parsed" ||
          (row.event_type !== "vstp.create" &&
            row.event_type !== "vstp.overwrite" &&
            row.event_type !== "vstp.delete")
        ) {
          continue;
        }

        const record = extractScheduleSourceRecord(row.raw_event_json);
        if (!record) {
          summary.skippedInvalid += 1;
          continue;
        }

        if (row.event_type === "vstp.delete") {
          const didDelete = await applyDelete(client, record);
          if (didDelete) summary.deleted += 1;
        } else {
          await applyCreateOrOverwrite(client, record);
          summary.applied += 1;
        }
      }

      await advanceCheckpoint(client, definitionId, maxSequence.toString());
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  return summary;
}
