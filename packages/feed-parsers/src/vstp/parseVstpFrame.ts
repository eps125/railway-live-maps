import { gunzipSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeTimestamp } from "../td/normalizeTimestamp.js";
import { computeSemanticHash } from "../td/semanticHash.js";
import { VSTP_PARSER_VERSION } from "./vstpParserVersion.js";

/**
 * VSTP (docs/REFERENCES.md: https://wiki.openraildata.com/index.php/VSTP) is XML, unlike TD's
 * JSON — the wire shape below (`VSTPCIFMsgV1` root, `schedule`/`CIF_bs` element names,
 * `transaction_type` of Create/Overwrite/Delete) is constructed from the publicly documented
 * format, not a captured real message (per the M0 fixture gap noted in
 * docs/IMPLEMENTATION_PLAN.md — no sanitized VSTP capture exists yet). Flagged here and in the
 * fixtures directory the same way M5's PX/CL binding note flags an unverified assumption:
 * confirm against a real capture before treating field names/shapes as exact.
 */
export type VstpParseStatus = "parsed" | "unsupported" | "malformed";
export type VstpTransactionType = "Create" | "Overwrite" | "Delete";

export interface ParsedVstpChild {
  childIndex: number;
  /** `"vstp.create"` / `"vstp.overwrite"` / `"vstp.delete"` for recognized transaction types,
   * or the literal transaction_type text (`"vstp.unknown:<text>"`) for an unrecognized one —
   * always non-empty, matching `raw_feed_event.event_type not null`. */
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

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

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

  // fast-xml-parser's own .parse() is lenient by design and won't reliably throw on malformed
  // input, so validity is checked explicitly first — this is what actually catches truncated/
  // unclosed-tag bodies rather than silently producing a partial/wrong tree.
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    return {
      children: [
        makeSyntheticMalformed("invalid_xml", options.receivedAt, {
          note: "body was not valid XML",
          validationError: validation.err,
          textSnippet: text.slice(0, 2000),
        }),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(text) as unknown;
  } catch {
    return {
      children: [
        makeSyntheticMalformed("invalid_xml", options.receivedAt, {
          note: "body was not valid XML",
          textSnippet: text.slice(0, 2000),
        }),
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      children: [
        makeSyntheticMalformed("not_an_object", options.receivedAt, {
          note: "parsed XML was not an object",
          value: parsed,
        }),
      ],
    };
  }

  const rootKeys = Object.keys(parsed as Record<string, unknown>).filter(
    (key) => !key.startsWith("?"),
  );
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
    // Structurally fine XML, semantically unrecognized root element: retained, never dropped —
    // same rule TD's classifier applies to an unrecognized wrapper key.
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

  const cifBs = schedule.CIF_bs as Record<string, unknown> | undefined;
  const transactionType = schedule.transaction_type ?? cifBs?.transaction_type;
  const rawTimestampText =
    typeof schedule["@_timestamp"] === "string" || typeof schedule["@_timestamp"] === "number"
      ? String(schedule["@_timestamp"])
      : null;

  const eventType = transactionEventType(transactionType);
  const parseStatus: VstpParseStatus = eventType.startsWith("vstp.unknown:")
    ? "unsupported"
    : "parsed";

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
