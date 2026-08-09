import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { getImmutableObject } from "@railway/archive";
import { parseVstpFrame } from "@railway/feed-parsers";

export interface ReparseVstpArchiveOptions {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

export interface ReparseVstpArchiveSummary {
  totalEvents: number;
  changed: number;
  unchanged: number;
  errors: number;
}

interface ArchivedVstpRow {
  event_id: string;
  normalized_event_at_utc: Date;
  frame_id: string;
  frame_received_at: Date;
  object_key: string;
  bucket: string;
  old_parse_status: string;
  old_event_type: string;
}

/**
 * Fixes historical `raw_feed_event` rows for VSTP that were parsed and permanently stored
 * *before* parseVstpFrame.ts was corrected from an unverified XML-shape guess to VSTP's actual
 * JSON wire format. Re-running the projector (even with `--rebuild`) can't fix this on its own:
 * the projector only ever reads back whatever's already sitting in `raw_feed_event` — parsing
 * itself happens exactly once, at ingestion time, and a parser fix deployed afterward doesn't
 * retroactively touch rows a *previous* parser version already wrote.
 *
 * The original bytes are safe regardless of any of this: CLAUDE.md's archive-before-ack sequence
 * durably archives every frame's untouched original bytes before parsing ever runs, specifically
 * so a case exactly like this — "we parsed it wrong" — is recoverable rather than being data loss.
 * This walks every VSTP `raw_feed_event` row back to its archived object, re-parses the original
 * bytes with the *current* parser, and replaces the row in place (same id, matching
 * normalized_event_at_utc so the update targets the correct partition) if the result differs —
 * touching `feed_frame`'s own parse-status/count columns to match, so nothing reads a
 * self-contradictory mix of old and new state afterward.
 *
 * Deliberately leaves `ingestion_sequence` untouched — an UPDATE in place, not a delete+reinsert
 * — so replaying doesn't fabricate a "just arrived" ordering relative to unrelated TD/TRUST
 * traffic sharing the same sequence. Projections (project-vstp) still need a follow-up
 * `--rebuild` afterward: fixing these rows doesn't itself re-trigger projection, since the
 * vstp-schedule checkpoint has long since advanced past their (low, historical) sequence numbers.
 */
export async function reparseVstpArchive(
  pool: Pool,
  archiveClient: S3Client,
  options: ReparseVstpArchiveOptions = {},
): Promise<ReparseVstpArchiveSummary> {
  const rows = await pool.query<ArchivedVstpRow>(
    `select rfe.id as event_id, rfe.normalized_event_at_utc, ff.id as frame_id,
            ff.received_at as frame_received_at, rao.object_key, rao.bucket,
            rfe.parse_status as old_parse_status, rfe.event_type as old_event_type
     from raw_feed_event rfe
     join feed_frame ff on ff.id = rfe.frame_id
     join raw_archive_object rao on rao.id = ff.archive_object_id
     where rfe.feed_name = 'VSTP'
     order by rfe.ingestion_sequence`,
  );

  const summary: ReparseVstpArchiveSummary = {
    totalEvents: rows.rows.length,
    changed: 0,
    unchanged: 0,
    errors: 0,
  };

  for (const row of rows.rows) {
    try {
      const body = await getImmutableObject({
        client: archiveClient,
        bucket: row.bucket,
        key: row.object_key,
      });
      const reparsed = parseVstpFrame(body, { receivedAt: row.frame_received_at });
      const child = reparsed.children[0];
      if (!child) {
        // parseVstpFrame always returns exactly one child (see its own doc comment) — this
        // would mean that invariant broke, not a normal "nothing to do" case.
        summary.errors += 1;
        console.error(`reparse-vstp-archive: no child produced for event ${row.event_id}`);
        continue;
      }

      if (child.parseStatus === row.old_parse_status && child.eventType === row.old_event_type) {
        summary.unchanged += 1;
        continue;
      }

      summary.changed += 1;
      console.log(
        `${options.dryRun ? "[dry-run] " : ""}event ${row.event_id}: ` +
          `${row.old_parse_status}/${row.old_event_type} -> ${child.parseStatus}/${child.eventType}`,
      );
      if (options.dryRun) {
        continue;
      }

      await pool.query(
        `update raw_feed_event
         set normalized_event_at_utc = $2, event_type = $3, message_class = $4, td_area = $5,
             raw_event_json = $6, raw_source_timestamp_ms = $7, raw_source_timestamp_text = $8,
             timestamp_correction_code = $9, timestamp_correction_details = $10,
             semantic_hash = $11, parse_status = $12, parse_error_code = $13, parse_version = $14
         where id = $1 and normalized_event_at_utc = $15`,
        [
          row.event_id,
          child.normalizedEventAtUtc,
          child.eventType,
          child.messageClass,
          child.tdArea,
          JSON.stringify(child.rawEventJson),
          child.rawSourceTimestampMs,
          child.rawSourceTimestampText,
          child.timestampCorrectionCode,
          child.timestampCorrectionDetails,
          child.semanticHash,
          child.parseStatus,
          child.parseErrorCode,
          child.parseVersion,
          row.normalized_event_at_utc,
        ],
      );

      const frameParseStatus =
        child.parseStatus === "parsed"
          ? "ok"
          : child.parseStatus === "unsupported"
            ? "partial"
            : "failed";
      await pool.query(
        `update feed_frame
         set parse_status = $2, parsed_child_count = $3, unsupported_child_count = $4,
             failed_child_count = $5
         where id = $1`,
        [
          row.frame_id,
          frameParseStatus,
          child.parseStatus === "parsed" ? 1 : 0,
          child.parseStatus === "unsupported" ? 1 : 0,
          child.parseStatus === "malformed" ? 1 : 0,
        ],
      );
    } catch (error) {
      summary.errors += 1;
      console.error(`reparse-vstp-archive: failed for event ${row.event_id}:`, error);
    }
  }

  return summary;
}
