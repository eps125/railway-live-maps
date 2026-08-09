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
 * Adapts the raw VSTP JSON (see `parseVstpFrame.ts`'s doc comment for the confirmed-real shape:
 * root `VSTPCIFMsgV1.schedule`, fields directly on `schedule` — no `CIF_bs` wrapper, that was
 * part of an earlier unverified XML-based guess) into the source-agnostic `ScheduleSourceRecord`
 * shape `mapToScheduleRow` expects. Returns `null` when a required field is missing/unrecognized
 * — the raw event itself is still retained untouched in `raw_feed_event`, only its projection
 * into `schedule` is skipped.
 */
function extractScheduleSourceRecord(rawEventJson: unknown): ScheduleSourceRecord | null {
  const root = rawEventJson as Record<string, unknown>;
  const msg = root?.VSTPCIFMsgV1 as Record<string, unknown> | undefined;
  const schedule = msg?.schedule as Record<string, unknown> | undefined;
  if (!schedule) return null;

  const trainUid = schedule.CIF_train_uid;
  const scheduleStartDate = schedule.schedule_start_date;
  const scheduleEndDate = schedule.schedule_end_date;
  const stpIndicator = schedule.CIF_stp_indicator;
  if (
    typeof trainUid !== "string" ||
    typeof scheduleStartDate !== "string" ||
    typeof scheduleEndDate !== "string" ||
    typeof stpIndicator !== "string" ||
    !VALID_STP_INDICATORS.has(stpIndicator)
  ) {
    return null;
  }

  // schedule_segment is an array on the wire (one element in the real message this was built
  // from, but not assumed to always be exactly one) — signalling_id/service code/category/power
  // type live one level down inside each segment, not on `schedule` itself. Locations are
  // flattened across every segment in order, tolerant of more than one.
  const rawSegments = schedule.schedule_segment;
  const segmentList: Record<string, unknown>[] = Array.isArray(rawSegments)
    ? (rawSegments as Record<string, unknown>[])
    : rawSegments
      ? [rawSegments as Record<string, unknown>]
      : [];
  const firstSegment = segmentList[0];

  const locations: ScheduleSourceLocation[] = segmentList.flatMap((seg) => {
    const rawLocations = seg.schedule_location;
    const locationList: Record<string, unknown>[] = Array.isArray(rawLocations)
      ? (rawLocations as Record<string, unknown>[])
      : rawLocations
        ? [rawLocations as Record<string, unknown>]
        : [];

    return locationList.map((loc) => {
      const locationObj = loc.location as Record<string, unknown> | undefined;
      const tiplocObj = locationObj?.tiploc as Record<string, unknown> | undefined;
      const tiploc = typeof tiplocObj?.tiploc_id === "string" ? tiplocObj.tiploc_id : "";
      const activityText = typeof loc.CIF_activity === "string" ? loc.CIF_activity : null;

      return {
        // No location-type code (e.g. LO/LI/LT) has been observed on the wire — mapToScheduleRow
        // (packages/domain) already falls back to first/last position when it doesn't recognize
        // one, so an empty string here is honest rather than guessing a code never actually seen.
        locationType: "",
        tiploc,
        arrivalPublic: typeof loc.public_arrival_time === "string" ? loc.public_arrival_time : null,
        arrivalWorking:
          typeof loc.scheduled_arrival_time === "string" ? loc.scheduled_arrival_time : null,
        departurePublic:
          typeof loc.public_departure_time === "string" ? loc.public_departure_time : null,
        departureWorking:
          typeof loc.scheduled_departure_time === "string" ? loc.scheduled_departure_time : null,
        passWorking: typeof loc.scheduled_pass_time === "string" ? loc.scheduled_pass_time : null,
        platform: typeof loc.CIF_platform === "string" ? loc.CIF_platform : null,
        path: typeof loc.CIF_path === "string" ? loc.CIF_path : null,
        line: typeof loc.CIF_line === "string" ? loc.CIF_line : null,
        activityCodes: activityText ? (activityText.match(/.{1,2}/g) ?? []) : [],
        rawActivityText: activityText,
      };
    });
  });

  return {
    trainUid,
    scheduleStartDate,
    scheduleEndDate,
    stpIndicator: stpIndicator as ScheduleSourceRecord["stpIndicator"],
    daysRunsBitmask:
      typeof schedule.schedule_days_runs === "string" ? schedule.schedule_days_runs : null,
    signallingId:
      typeof firstSegment?.signalling_id === "string" ? firstSegment.signalling_id : null,
    // Confirmed absent, not just unobserved: the sibling `Sender` object (message provenance —
    // userID/component/sessionID/application/organisation) is who *sent* the VSTP message, not
    // the train's operating company, and no other field anywhere in a real captured message
    // carries an ATOC/operator code.
    operatorCode: null,
    trainServiceCode:
      typeof firstSegment?.CIF_train_service_code === "string"
        ? firstSegment.CIF_train_service_code
        : null,
    trainCategory:
      typeof firstSegment?.CIF_train_category === "string" ? firstSegment.CIF_train_category : null,
    trainStatus: typeof schedule.train_status === "string" ? schedule.train_status : null,
    powerType:
      typeof firstSegment?.CIF_power_type === "string" ? firstSegment.CIF_power_type : null,
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
            row.event_type !== "vstp.update" &&
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
          // "Update" (a real, undocumented transaction type — see parseVstpFrame.ts's doc
          // comment) carries a complete schedule payload just like Create/Overwrite, so it's
          // applied identically: a full-schedule upsert, not a partial patch.
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
