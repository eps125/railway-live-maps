import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";

/** Test-only helper (not shipped application logic): drives a real `td_berth_event` row
 * through the full FK chain (`raw_archive_object` -> `feed_frame` -> `raw_feed_event` ->
 * `td_berth_event`) so integration tests can prove "ever observed" checks against a realistic
 * row rather than a shortcut that skips the schema's real constraints — mirrors
 * `routes/liveMap.integration.test.ts`'s `setBerthCurrentState` helper, one table over. */
export async function recordObservedBerthEvent(
  pool: Pool,
  tdArea: string,
  fromBerth: string | null,
  toBerth: string | null,
  description: string,
): Promise<void> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const archiveObjectId = archiveResult.rows[0]!.id;

  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveObjectId],
  );
  const frameId = frameResult.rows[0]!.id;

  const now = new Date();
  const messageType = fromBerth && toBerth ? "CA" : toBerth ? "CC" : "CB";
  const eventResult = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, 'C', $3, '{}', $4, $4, $5, 'parsed', 1)
     returning id, ingestion_sequence`,
    [frameId, messageType, tdArea, now, randomUUID()],
  );
  const eventId = eventResult.rows[0]!.id;
  const ingestionSequence = eventResult.rows[0]!.ingestion_sequence;

  await pool.query(
    `insert into td_berth_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth,
       description, event_at, ingestion_sequence, normalization_version
     ) values ($1, $2, $3, $4, $5, $6, $7, $2, $8, 1)`,
    [eventId, now, tdArea, messageType, fromBerth, toBerth, description, ingestionSequence],
  );

  if (toBerth) {
    await pool.query(
      `insert into berth_current_state (
         projection_version, td_area, berth_code, description, occupancy_entered_at, event_at,
         source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
       ) values ($1, $2, $3, $4, $5, $5, $6, $5, $7)
       on conflict (projection_version, td_area, berth_code) do update set
         description = excluded.description, occupancy_entered_at = excluded.occupancy_entered_at,
         event_at = excluded.event_at, source_event_id = excluded.source_event_id,
         source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
         source_ingestion_sequence = excluded.source_ingestion_sequence`,
      [TD_PROJECTION_VERSION, tdArea, toBerth, description, now, eventId, ingestionSequence],
    );
  }
}
