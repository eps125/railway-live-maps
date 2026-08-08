import { sha256Hex, computeArchiveObjectKey, putImmutableObject } from "@railway/archive";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import type { FeedName } from "@railway/domain";

/**
 * Milestone 7: generalized from `apps/worker/src/td/recorder.ts`'s `recordFrame` (which now
 * calls this with `feedName: "TD"`, `archiveNamespace: "td"`, `parseFn: parseTdFrame`) so
 * VSTP/TRUST reuse the exact archive-before-ack sequence instead of each reimplementing it.
 * The `raw_feed_event` insert itself was already feed-agnostic — every column here already
 * matched `ParsedTdChild`'s shape one-for-one — so this extraction is mechanical, not a new
 * design.
 */
export interface ParsedChild {
  childIndex: number;
  eventType: string;
  messageClass: "C" | "S" | null;
  tdArea: string | null;
  rawEventJson: unknown;
  rawSourceTimestampMs: number | null;
  rawSourceTimestampText: string | null;
  normalizedEventAtUtc: string;
  timestampCorrectionCode: string;
  timestampCorrectionDetails: string | null;
  semanticHash: string;
  parseStatus: "parsed" | "unsupported" | "malformed";
  parseErrorCode: string | null;
  parseVersion: number;
}

export interface ParsedFrame {
  children: ParsedChild[];
}

export interface InboundBrokerFrame {
  feedName: FeedName;
  topic: string;
  brokerMessageId: string | undefined;
  headers: Record<string, string>;
  /** Raw bytes exactly as received — still gzip-compressed if the broker sent it that way.
   * These exact bytes are what gets archived; parsing/decompression happens separately. */
  body: Buffer;
  receivedAt: Date;
  connectionSessionId: string | null;
}

export interface RecordBrokerFrameDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
  /** Archive object key namespace — `"td"`/`"vstp"`/`"trust"`, keeps each feed's archived
   * bodies in their own key prefix. */
  archiveNamespace: string;
  parseFn: (body: Buffer, options: { receivedAt: Date }) => ParsedFrame;
}

export interface RecordBrokerFrameResult {
  frameId: string;
  /** true = this exact frame was already durably recorded (broker redelivery); the caller
   * should just ack, nothing was re-parsed or re-inserted. */
  alreadyRecorded: boolean;
  childCount: number;
  parsedChildCount: number;
  unsupportedChildCount: number;
  failedChildCount: number;
  /** The latest `normalizedEventAtUtc` among this frame's children (null for an
   * already-recorded/redelivered frame, or a frame with no children) — lets a caller measure
   * end-to-end lag (wall clock minus this) without a second query. See
   * `apps/worker/src/shared/ingestStats.ts`, which is what actually logs it. */
  newestNormalizedEventAtUtc: string | null;
}

interface UpsertArchiveObjectInput {
  objectKey: string;
  bucket: string;
  contentSha256: string;
  compressedSizeBytes: number;
}

async function upsertArchiveObjectIndex(
  pool: Pool,
  input: UpsertArchiveObjectInput,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, $2, $3, $4, 'broker-frame')
     on conflict (object_key) do nothing
     returning id`,
    [input.objectKey, input.bucket, input.contentSha256, input.compressedSizeBytes],
  );
  if (inserted.rows[0]) {
    return inserted.rows[0].id;
  }
  const existing = await pool.query<{ id: string }>(
    "select id from raw_archive_object where object_key = $1",
    [input.objectKey],
  );
  const id = existing.rows[0]?.id;
  if (!id) {
    throw new Error(`Expected raw_archive_object row for key ${input.objectKey} to exist`);
  }
  return id;
}

/**
 * Implements the exact archive-before-ack sequence from docs/ARCHITECTURE.md §5: checksum
 * -> deterministic key -> S3 PUT -> raw_archive_object upsert (its own commit, ahead of the
 * main transaction so reconcile-archive can find it even if the process crashes next) ->
 * begin transaction -> feed_frame upsert (the idempotency guard) -> parse -> insert every
 * child row (including malformed/unsupported — never dropped) -> update frame counts ->
 * commit. The caller acks the broker frame (or the fixture connection's ack()) only after
 * this resolves, then calls markFrameAcked.
 */
export async function recordBrokerFrame(
  frame: InboundBrokerFrame,
  deps: RecordBrokerFrameDeps,
): Promise<RecordBrokerFrameResult> {
  const bodyHash = sha256Hex(frame.body);
  const objectKey = computeArchiveObjectKey({
    namespace: deps.archiveNamespace,
    contentSha256: bodyHash,
    date: frame.receivedAt,
  });

  await putImmutableObject({
    client: deps.archiveClient,
    bucket: deps.archiveBucket,
    key: objectKey,
    body: frame.body,
    contentType: "application/octet-stream",
  });

  const archiveObjectId = await upsertArchiveObjectIndex(deps.pool, {
    objectKey,
    bucket: deps.archiveBucket,
    contentSha256: bodyHash,
    compressedSizeBytes: frame.body.length,
  });

  const client = await deps.pool.connect();
  try {
    await client.query("begin");

    const insertFrame = await client.query<{ id: string }>(
      `insert into feed_frame (feed_name, topic, broker_message_id, headers_json, received_at, body_hash, archive_object_id, connection_session_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (feed_name, body_hash) do nothing
       returning id`,
      [
        frame.feedName,
        frame.topic,
        frame.brokerMessageId ?? null,
        JSON.stringify(frame.headers),
        frame.receivedAt,
        bodyHash,
        archiveObjectId,
        frame.connectionSessionId,
      ],
    );

    if (insertFrame.rows.length === 0) {
      await client.query("commit");
      const existing = await deps.pool.query<{ id: string }>(
        "select id from feed_frame where feed_name = $1 and body_hash = $2",
        [frame.feedName, bodyHash],
      );
      const frameId = existing.rows[0]?.id;
      if (!frameId) {
        throw new Error(
          `Expected feed_frame row for body_hash ${bodyHash} to exist after conflict`,
        );
      }
      return {
        frameId,
        alreadyRecorded: true,
        childCount: 0,
        parsedChildCount: 0,
        unsupportedChildCount: 0,
        failedChildCount: 0,
        newestNormalizedEventAtUtc: null,
      };
    }

    const frameId = insertFrame.rows[0]?.id;
    if (!frameId) {
      throw new Error("Expected feed_frame insert to return an id");
    }

    const parsed = deps.parseFn(frame.body, { receivedAt: frame.receivedAt });

    let parsedCount = 0;
    let unsupportedCount = 0;
    let failedCount = 0;

    for (const child of parsed.children) {
      await client.query(
        `insert into raw_feed_event (
           frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
           raw_source_timestamp_ms, raw_source_timestamp_text, normalized_event_at_utc, received_at_utc,
           timestamp_correction_code, timestamp_correction_details, semantic_hash, parse_status,
           parse_error_code, parse_version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          frameId,
          child.childIndex,
          frame.feedName,
          child.eventType,
          child.messageClass,
          child.tdArea,
          JSON.stringify(child.rawEventJson),
          child.rawSourceTimestampMs,
          child.rawSourceTimestampText,
          child.normalizedEventAtUtc,
          frame.receivedAt,
          child.timestampCorrectionCode,
          child.timestampCorrectionDetails,
          child.semanticHash,
          child.parseStatus,
          child.parseErrorCode,
          child.parseVersion,
        ],
      );

      if (child.parseStatus === "parsed") parsedCount += 1;
      else if (child.parseStatus === "unsupported") unsupportedCount += 1;
      else failedCount += 1;
    }

    const frameParseStatus =
      failedCount === parsed.children.length
        ? "failed"
        : failedCount > 0 || unsupportedCount > 0
          ? "partial"
          : "ok";

    await client.query(
      `update feed_frame
       set child_count = $2, parsed_child_count = $3, unsupported_child_count = $4,
           failed_child_count = $5, parse_status = $6
       where id = $1`,
      [
        frameId,
        parsed.children.length,
        parsedCount,
        unsupportedCount,
        failedCount,
        frameParseStatus,
      ],
    );

    await client.query("commit");

    let newestNormalizedEventAtUtc: string | null = null;
    for (const child of parsed.children) {
      if (!newestNormalizedEventAtUtc || child.normalizedEventAtUtc > newestNormalizedEventAtUtc) {
        newestNormalizedEventAtUtc = child.normalizedEventAtUtc;
      }
    }

    return {
      frameId,
      alreadyRecorded: false,
      childCount: parsed.children.length,
      parsedChildCount: parsedCount,
      unsupportedChildCount: unsupportedCount,
      failedChildCount: failedCount,
      newestNormalizedEventAtUtc,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function markFrameAcked(pool: Pool, frameId: string): Promise<void> {
  await pool.query("update feed_frame set acked_at = now() where id = $1 and acked_at is null", [
    frameId,
  ]);
}
