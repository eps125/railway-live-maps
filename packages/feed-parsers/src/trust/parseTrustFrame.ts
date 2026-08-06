import { gunzipSync } from "node:zlib";
import { normalizeTimestamp } from "../td/normalizeTimestamp.js";
import { computeSemanticHash } from "../td/semanticHash.js";
import { TRUST_PARSER_VERSION } from "./trustParserVersion.js";

/**
 * TRUST/TRAIN_MVT_ALL_TOC (docs/REFERENCES.md's Train Movements/Train Activation wiki links)
 * is delivered as a JSON array of `{header: {msg_type, ...}, body: {...}}` messages per STOMP
 * frame — the same per-frame-array shape as TD, but each message carries its own type
 * discriminator in `header.msg_type` rather than a single wrapper key. The wire shape below
 * (field names, epoch-ms timestamps) is constructed from the publicly documented format, not
 * a captured real message — same M0 fixture-gap caveat as `vstp/parseVstpFrame.ts`. Confirm
 * against a real capture before treating field names/shapes as exact.
 */
export type TrustParseStatus = "parsed" | "unsupported" | "malformed";

export const TRUST_MESSAGE_TYPES = [
  "activation",
  "cancellation",
  "movement",
  "unidentified",
  "reinstatement",
  "change_of_origin",
  "change_of_identity",
  "change_of_location",
] as const;
export type TrustMessageType = (typeof TRUST_MESSAGE_TYPES)[number];

const MSG_TYPE_TO_TRUST_MESSAGE_TYPE: Record<string, TrustMessageType> = {
  "0001": "activation",
  "0002": "cancellation",
  "0003": "movement",
  "0005": "unidentified",
  "0006": "reinstatement",
  "0007": "change_of_origin",
  "0008": "change_of_identity",
  "0009": "change_of_location",
};

/** Fields carrying the message's own epoch-ms timestamp, tried in this order — different
 * TRUST message types name their primary timestamp differently on the wire. */
const TIMESTAMP_FIELD_PRIORITY = [
  "actual_timestamp",
  "creation_timestamp",
  "canx_timestamp",
  "reinstatement_timestamp",
  "origin_dep_timestamp",
  "event_timestamp",
];

export interface ParsedTrustChild {
  childIndex: number;
  /** `"<trust_message_type>"` for a recognized `header.msg_type` (e.g. `"activation"`), or
   * `"trust.unsupported_msg_type:<msg_type>"` for an unrecognized one — always non-empty. */
  eventType: string;
  /** Always null for TRUST — these two fields exist only so `ParsedTrustChild` satisfies the
   * shared `recordBrokerFrame.ts` `ParsedChild` shape, which TD's message_class/td_area fields
   * originally defined. */
  messageClass: null;
  tdArea: null;
  rawEventJson: unknown;
  rawSourceTimestampMs: number | null;
  rawSourceTimestampText: string | null;
  normalizedEventAtUtc: string;
  timestampCorrectionCode: string;
  timestampCorrectionDetails: string | null;
  semanticHash: string;
  parseStatus: TrustParseStatus;
  parseErrorCode: string | null;
  parseVersion: number;
}

export interface ParsedTrustFrame {
  children: ParsedTrustChild[];
}

export interface ParseTrustFrameOptions {
  receivedAt: Date;
}

function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function parseTimeMs(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

interface BuildResultInput {
  childIndex: number;
  eventType: string;
  rawEventJson: unknown;
  parseStatus: TrustParseStatus;
  parseErrorCode: string | null;
  receivedAt: Date;
  rawTimestampText: string | null;
}

function buildResult(input: BuildResultInput): ParsedTrustChild {
  const normalized = normalizeTimestamp(input.rawTimestampText, input.receivedAt);
  return {
    childIndex: input.childIndex,
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
    parseVersion: TRUST_PARSER_VERSION,
  };
}

function makeSyntheticMalformed(
  parseErrorCode: string,
  receivedAt: Date,
  childIndex: number,
  snippet: unknown,
): ParsedTrustChild {
  return buildResult({
    childIndex,
    eventType: "unknown",
    rawEventJson: snippet,
    parseStatus: "malformed",
    parseErrorCode,
    receivedAt,
    rawTimestampText: null,
  });
}

function extractTimestampText(body: Record<string, unknown>): string | null {
  for (const field of TIMESTAMP_FIELD_PRIORITY) {
    const value = body[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function classifyChild(raw: unknown, childIndex: number, receivedAt: Date): ParsedTrustChild {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return makeSyntheticMalformed("child_not_an_object", receivedAt, childIndex, raw);
  }

  const obj = raw as Record<string, unknown>;
  const header = obj.header;
  const body = obj.body;
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    return makeSyntheticMalformed("missing_or_invalid_header", receivedAt, childIndex, raw);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return makeSyntheticMalformed("missing_or_invalid_body", receivedAt, childIndex, raw);
  }

  const msgType = (header as Record<string, unknown>).msg_type;
  if (typeof msgType !== "string" || msgType.length === 0) {
    return makeSyntheticMalformed("missing_msg_type", receivedAt, childIndex, raw);
  }

  const rawTimestampText = extractTimestampText(body as Record<string, unknown>);
  const trustMessageType = MSG_TYPE_TO_TRUST_MESSAGE_TYPE[msgType];

  if (!trustMessageType) {
    // Structurally fine, semantically unrecognized msg_type: retained, never dropped — same
    // rule TD's classifier applies to an unrecognized wrapper key.
    return buildResult({
      childIndex,
      eventType: `trust.unsupported_msg_type:${msgType}`,
      rawEventJson: raw,
      parseStatus: "unsupported",
      parseErrorCode: null,
      receivedAt,
      rawTimestampText,
    });
  }

  return buildResult({
    childIndex,
    eventType: trustMessageType,
    rawEventJson: raw,
    parseStatus: "parsed",
    parseErrorCode: null,
    receivedAt,
    rawTimestampText,
  });
}

/**
 * Pure: no network/DB/filesystem I/O. Mirrors `parseTdFrame`'s never-drop invariant exactly —
 * every code path returns at least one child, and a totally unparseable body still yields one
 * synthetic `malformed` child.
 */
export function parseTrustFrame(body: Buffer, options: ParseTrustFrameOptions): ParsedTrustFrame {
  let text: string;
  try {
    const decompressed = isGzip(body) ? gunzipSync(body) : body;
    text = decompressed.toString("utf8");
  } catch {
    return {
      children: [
        makeSyntheticMalformed("gzip_decompress_failed", options.receivedAt, 0, {
          note: "gzip decompression failed",
          bodyBase64Prefix: body.subarray(0, 256).toString("base64"),
        }),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      children: [
        makeSyntheticMalformed("invalid_json", options.receivedAt, 0, {
          note: "body was not valid JSON",
          textSnippet: text.slice(0, 2000),
        }),
      ],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      children: [
        makeSyntheticMalformed("not_an_array", options.receivedAt, 0, {
          note: "body was valid JSON but not an array",
          value: parsed,
        }),
      ],
    };
  }

  if (parsed.length === 0) {
    return {
      children: [
        makeSyntheticMalformed("empty_array", options.receivedAt, 0, {
          note: "body was an empty JSON array",
        }),
      ],
    };
  }

  return {
    children: parsed.map((child, index) => classifyChild(child, index, options.receivedAt)),
  };
}
