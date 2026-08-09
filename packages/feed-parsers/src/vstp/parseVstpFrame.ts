import { gunzipSync } from "node:zlib";
import { normalizeTimestamp } from "../td/normalizeTimestamp.js";
import { computeSemanticHash } from "../td/semanticHash.js";
import { VSTP_PARSER_VERSION } from "./vstpParserVersion.js";

/**
 * VSTP (docs/REFERENCES.md: https://wiki.openraildata.com/index.php/VSTP) is JSON on the wire,
 * same as TD — confirmed against real captured messages. An earlier version of this parser
 * assumed an XML shape built from public documentation alone and was never verified: every real
 * message failed XML validation and was silently retained as "malformed" (parse_error_code
 * "invalid_xml") instead of ever reaching the schedule projector, so live VSTP data had never
 * actually produced a queryable schedule until this was corrected.
 *
 * Confirmed real shape: root key `VSTPCIFMsgV1`, with sibling keys `owner`, `Sender` (message
 * provenance metadata — `userID`/`component`/`sessionID`/`application`/`organisation`; this is
 * who sent the VSTP message, e.g. Network Rail's own system, not the train's operator — no
 * ATOC/operator code has been found anywhere in a real message, confirmed absent rather than
 * merely unobserved), `timestamp` (message-level epoch-*milliseconds* string, confirmed against
 * a real capture where it matched the human-readable date embedded in the sibling `originMsgId`
 * field), `classification`, `originMsgId`, and `schedule`.
 *
 * `schedule` carries `transaction_type`, `CIF_train_uid`, `schedule_start_date`,
 * `schedule_end_date`, `CIF_stp_indicator`, `schedule_days_runs`, `train_status`,
 * `applicable_timetable` directly — there is no `CIF_bs` wrapper (that nesting was part of the
 * unverified XML guess). `signalling_id`, `CIF_train_service_code`, `CIF_train_category`,
 * `CIF_timing_load`, `CIF_speed`, `CIF_power_type` sit one level down, inside
 * `schedule.schedule_segment[]` (an array). Each `schedule_location` nests as
 * `location.tiploc.tiploc_id` (not a flat `tiploc_code`), and carries
 * `scheduled_arrival_time`/`scheduled_departure_time`/`scheduled_pass_time`,
 * `public_arrival_time`/`public_departure_time`, `CIF_platform`, `CIF_path`, `CIF_line`,
 * `CIF_activity` — no explicit location-type code was observed (origin/terminus rows are
 * distinguishable only by `CIF_activity` "TB"/"TF" or by position); `mapToScheduleRow`
 * (packages/domain) already falls back to first/last position when it doesn't recognize a
 * location-type code, so the projector passes an empty string rather than guessing a code that
 * hasn't actually been observed on the wire.
 *
 * `transaction_type` has a fourth real value beyond the publicly documented Create/Overwrite/
 * Delete: `"Update"`, confirmed from a live message carrying a complete `schedule_segment`/
 * location payload structurally identical to a Create/Overwrite (not a partial patch) — handled
 * identically to Overwrite (full-schedule upsert) on that basis, in `vstp/projector.ts`.
 *
 * Confirm further against real captures as new shapes are seen rather than extending this from
 * assumption again — this is still built from a handful of real messages, not an exhaustive
 * sample.
 */
export type VstpParseStatus = "parsed" | "unsupported" | "malformed";
export type VstpTransactionType = "Create" | "Overwrite" | "Delete" | "Update";

export interface ParsedVstpChild {
  childIndex: number;
  /** `"vstp.create"` / `"vstp.overwrite"` / `"vstp.delete"` / `"vstp.update"` for recognized
   * transaction types, or the literal transaction_type text (`"vstp.unknown:<text>"`) for an
   * unrecognized one — always non-empty, matching `raw_feed_event.event_type not null`. */
  eventType: string;
  messageClass: null;
  tdArea: null;
  rawEventJson: unknown;
  rawSourceTimestampMs: number | null;
  rawSourceTimestampText: string | null;
  normalizedEventAtUtc: string;
  timestampCorrectionCode: string;
  timestampCorrectionDetails: string | null;
  semanticHash: string;
  parseStatus: VstpParseStatus;
  parseErrorCode: string | null;
  parseVersion: number;
}

export interface ParsedVstpFrame {
  children: ParsedVstpChild[];
}

export interface ParseVstpFrameOptions {
  receivedAt: Date;
}

// Bodies that fail to parse are retained with only a bounded snippet, not the full text —
// unbounded arbitrary input isn't something to persist wholesale into a jsonb column forever.
// The complete original bytes are still available regardless, in the archived raw frame
// (docs/ARCHITECTURE.md's archive-before-ack sequence) — this snippet is diagnostic only.
const MALFORMED_SNIPPET_LENGTH = 2000;

function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function parseTimeMs(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

interface BuildResultInput {
  eventType: string;
  rawEventJson: unknown;
  parseStatus: VstpParseStatus;
  parseErrorCode: string | null;
  receivedAt: Date;
  rawTimestampText: string | null;
}

function buildResult(input: BuildResultInput): ParsedVstpChild {
  const normalized = normalizeTimestamp(input.rawTimestampText, input.receivedAt);
  return {
    childIndex: 0,
    eventType: input.eventType,
    messageClass: null,
    tdArea: null,
    rawEventJson: input.rawEventJson,
    rawSourceTimestampMs: parseTimeMs(input.rawTimestampText),
    rawSourceTimestampText: input.rawTimestampText,
    normalizedEventAtUtc: normalized.normalizedEventAtUtc,
    timestampCorrectionCode: normalized.correctionCode,
    timestampCorrectionDetails: normalized.correctionDetails,
    semanticHash: computeSemanticHash(input.rawEventJson),
    parseStatus: input.parseStatus,
    parseErrorCode: input.parseErrorCode,
    parseVersion: VSTP_PARSER_VERSION,
  };
}

function makeSyntheticMalformed(
  parseErrorCode: string,
  receivedAt: Date,
  snippet: unknown,
): ParsedVstpChild {
  return buildResult({
    eventType: "unknown",
    rawEventJson: snippet,
    parseStatus: "malformed",
    parseErrorCode,
    receivedAt,
    rawTimestampText: null,
  });
}

function transactionEventType(transactionType: unknown): string {
  if (transactionType === "Create") return "vstp.create";
  if (transactionType === "Overwrite") return "vstp.overwrite";
  if (transactionType === "Delete") return "vstp.delete";
  // Confirmed real (not publicly documented alongside Create/Overwrite/Delete): carries a
  // complete schedule_segment/location payload just like Create/Overwrite, not a partial patch
  // — vstp/projector.ts treats it as a full-schedule upsert on that basis.
  if (transactionType === "Update") return "vstp.update";
  return `vstp.unknown:${String(transactionType)}`;
}

/**
 * Pure: no network/DB/filesystem I/O. Mirrors `parseTdFrame`'s never-drop invariant exactly —
 * every code path returns exactly one child (VSTP is one schedule transaction per message,
 * unlike TD's per-frame array), and a totally unparseable body still yields one synthetic
 * `malformed` child.
 */
export function parseVstpFrame(body: Buffer, options: ParseVstpFrameOptions): ParsedVstpFrame {
  let text: string;
  try {
    const decompressed = isGzip(body) ? gunzipSync(body) : body;
    text = decompressed.toString("utf8");
  } catch {
    return {
      children: [
        makeSyntheticMalformed("gzip_decompress_failed", options.receivedAt, {
          note: "gzip decompression failed",
          bodyBase64Prefix: body.subarray(0, 256).toString("base64"),
        }),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      children: [
        makeSyntheticMalformed("invalid_json", options.receivedAt, {
          note: "body was not valid JSON",
          textSnippet: text.slice(0, MALFORMED_SNIPPET_LENGTH),
        }),
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      children: [
        makeSyntheticMalformed("not_an_object", options.receivedAt, {
          note: "parsed JSON was not an object",
          value: parsed,
        }),
      ],
    };
  }

  const rootKeys = Object.keys(parsed as Record<string, unknown>);
  if (rootKeys.length !== 1) {
    return {
      children: [
        makeSyntheticMalformed("unexpected_root_element_count", options.receivedAt, parsed),
      ],
    };
  }

  const rootKey = rootKeys[0] as string;
  const root = (parsed as Record<string, unknown>)[rootKey];

  if (rootKey !== "VSTPCIFMsgV1") {
    // Structurally fine JSON, semantically unrecognized root key: retained, never dropped — same
    // rule TD's classifier applies to an unrecognized wrapper key.
    return {
      children: [
        buildResult({
          eventType: `vstp.unsupported_root:${rootKey}`,
          rawEventJson: parsed,
          parseStatus: "unsupported",
          parseErrorCode: null,
          receivedAt: options.receivedAt,
          rawTimestampText: null,
        }),
      ],
    };
  }

  if (typeof root !== "object" || root === null) {
    return {
      children: [makeSyntheticMalformed("root_payload_not_object", options.receivedAt, parsed)],
    };
  }

  const rootObj = root as Record<string, unknown>;
  const schedule = rootObj.schedule as Record<string, unknown> | undefined;
  if (!schedule) {
    return {
      children: [makeSyntheticMalformed("missing_schedule_element", options.receivedAt, parsed)],
    };
  }

  const eventType = transactionEventType(schedule.transaction_type);
  const parseStatus: VstpParseStatus = eventType.startsWith("vstp.unknown:")
    ? "unsupported"
    : "parsed";
  // Confirmed real: an epoch-milliseconds string sitting on the message root, sibling to
  // `schedule` — not inside it. Falls back to receivedAt via normalizeTimestamp if absent/
  // unparseable, same as any source lacking one.
  const rawTimestampText =
    typeof rootObj.timestamp === "string" || typeof rootObj.timestamp === "number"
      ? String(rootObj.timestamp)
      : null;

  return {
    children: [
      buildResult({
        eventType,
        rawEventJson: parsed,
        parseStatus,
        parseErrorCode: null,
        receivedAt: options.receivedAt,
        rawTimestampText,
      }),
    ],
  };
}
