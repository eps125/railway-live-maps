import { gunzipSync } from "node:zlib";
import type { TdCClassMessageType, TdMessageClass } from "@railway/domain";
import { normalizeTimestamp } from "./normalizeTimestamp.js";
import { computeSemanticHash } from "./semanticHash.js";
import { TD_PARSER_VERSION } from "./parserVersion.js";

export type TdParseStatus = "parsed" | "unsupported" | "malformed";

export interface ParsedTdChild {
  childIndex: number;
  eventType: string;
  messageClass: TdMessageClass | null;
  tdArea: string | null;
  rawEventJson: unknown;
  rawSourceTimestampMs: number | null;
  rawSourceTimestampText: string | null;
  normalizedEventAtUtc: string;
  timestampCorrectionCode: string;
  timestampCorrectionDetails: string | null;
  semanticHash: string;
  parseStatus: TdParseStatus;
  parseErrorCode: string | null;
  parseVersion: number;
}

export interface ParsedTdFrame {
  children: ParsedTdChild[];
}

export interface ParseTdFrameOptions {
  receivedAt: Date;
}

const C_CLASS_WRAPPER_KEYS: Record<string, TdCClassMessageType> = {
  CA_MSG: "CA",
  CB_MSG: "CB",
  CC_MSG: "CC",
  CT_MSG: "CT",
};
const S_CLASS_WRAPPER_PATTERN = /^S[A-Z]_MSG$/;

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
  messageClass: TdMessageClass | null;
  tdArea: string | null;
  rawEventJson: unknown;
  parseStatus: TdParseStatus;
  parseErrorCode: string | null;
  receivedAt: Date;
  rawTimestampText: string | null;
}

function buildResult(input: BuildResultInput): ParsedTdChild {
  const normalized = normalizeTimestamp(input.rawTimestampText, input.receivedAt);
  return {
    childIndex: input.childIndex,
    eventType: input.eventType,
    messageClass: input.messageClass,
    tdArea: input.tdArea,
    rawEventJson: input.rawEventJson,
    rawSourceTimestampMs: parseTimeMs(input.rawTimestampText),
    rawSourceTimestampText: input.rawTimestampText,
    normalizedEventAtUtc: normalized.normalizedEventAtUtc,
    timestampCorrectionCode: normalized.correctionCode,
    timestampCorrectionDetails: normalized.correctionDetails,
    semanticHash: computeSemanticHash(input.rawEventJson),
    parseStatus: input.parseStatus,
    parseErrorCode: input.parseErrorCode,
    parseVersion: TD_PARSER_VERSION,
  };
}

function makeSyntheticMalformed(
  parseErrorCode: string,
  receivedAt: Date,
  snippet: unknown,
): ParsedTdChild {
  return buildResult({
    childIndex: 0,
    eventType: "unknown",
    messageClass: null,
    tdArea: null,
    rawEventJson: snippet,
    parseStatus: "malformed",
    parseErrorCode,
    receivedAt,
    rawTimestampText: null,
  });
}

function classifyCClass(
  messageType: TdCClassMessageType,
  payload: unknown,
  childIndex: number,
  raw: unknown,
  receivedAt: Date,
): ParsedTdChild {
  if (typeof payload !== "object" || payload === null) {
    return buildResult({
      childIndex,
      eventType: messageType,
      messageClass: "C",
      tdArea: null,
      rawEventJson: raw,
      parseStatus: "malformed",
      parseErrorCode: "payload_not_object",
      receivedAt,
      rawTimestampText: null,
    });
  }

  const p = payload as Record<string, unknown>;
  const tdArea = typeof p.area_id === "string" ? p.area_id : null;
  const rawTimestampText =
    typeof p.time === "string" ? p.time : typeof p.report_time === "string" ? p.report_time : null;

  const requiredFieldsPresent = ((): boolean => {
    switch (messageType) {
      case "CA":
        return (
          typeof p.from === "string" && typeof p.to === "string" && typeof p.descr === "string"
        );
      case "CB":
        return typeof p.from === "string" && typeof p.descr === "string";
      case "CC":
        return typeof p.to === "string" && typeof p.descr === "string";
      case "CT":
        return typeof p.report_time === "string";
    }
  })();

  if (!tdArea || !rawTimestampText || !requiredFieldsPresent) {
    return buildResult({
      childIndex,
      eventType: messageType,
      messageClass: "C",
      tdArea,
      rawEventJson: raw,
      parseStatus: "malformed",
      parseErrorCode: "missing_required_field",
      receivedAt,
      rawTimestampText,
    });
  }

  return buildResult({
    childIndex,
    eventType: messageType,
    messageClass: "C",
    tdArea,
    rawEventJson: raw,
    parseStatus: "parsed",
    parseErrorCode: null,
    receivedAt,
    rawTimestampText,
  });
}

function classifySClass(
  wrapperKey: string,
  payload: unknown,
  childIndex: number,
  raw: unknown,
  receivedAt: Date,
): ParsedTdChild {
  if (typeof payload !== "object" || payload === null) {
    return buildResult({
      childIndex,
      eventType: wrapperKey,
      messageClass: "S",
      tdArea: null,
      rawEventJson: raw,
      parseStatus: "malformed",
      parseErrorCode: "payload_not_object",
      receivedAt,
      rawTimestampText: null,
    });
  }

  const p = payload as Record<string, unknown>;
  const tdArea = typeof p.area_id === "string" ? p.area_id : null;
  const rawTimestampText = typeof p.time === "string" ? p.time : null;

  if (!tdArea) {
    return buildResult({
      childIndex,
      eventType: wrapperKey,
      messageClass: "S",
      tdArea: null,
      rawEventJson: raw,
      parseStatus: "malformed",
      parseErrorCode: "missing_area_id",
      receivedAt,
      rawTimestampText,
    });
  }

  return buildResult({
    childIndex,
    eventType: wrapperKey,
    messageClass: "S",
    tdArea,
    rawEventJson: raw,
    parseStatus: "parsed",
    parseErrorCode: null,
    receivedAt,
    rawTimestampText,
  });
}

function classifyChild(raw: unknown, childIndex: number, receivedAt: Date): ParsedTdChild {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return buildResult({
      childIndex,
      eventType: "unknown",
      messageClass: null,
      tdArea: null,
      rawEventJson: raw,
      parseStatus: "malformed",
      parseErrorCode: "child_not_an_object",
      receivedAt,
      rawTimestampText: null,
    });
  }

  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1) {
    return buildResult({
      childIndex,
      eventType: "unknown",
      messageClass: null,
      tdArea: null,
      rawEventJson: raw,
      parseStatus: "malformed",
      parseErrorCode: "unexpected_wrapper_key_count",
      receivedAt,
      rawTimestampText: null,
    });
  }

  const wrapperKey = keys[0] as string;
  const payload = (raw as Record<string, unknown>)[wrapperKey];

  const cClassType = C_CLASS_WRAPPER_KEYS[wrapperKey];
  if (cClassType) {
    return classifyCClass(cClassType, payload, childIndex, raw, receivedAt);
  }
  if (S_CLASS_WRAPPER_PATTERN.test(wrapperKey)) {
    return classifySClass(wrapperKey, payload, childIndex, raw, receivedAt);
  }

  // Structurally fine JSON, semantically unrecognized wrapper key: retained, never dropped.
  return buildResult({
    childIndex,
    eventType: wrapperKey,
    messageClass: null,
    tdArea: null,
    rawEventJson: raw,
    parseStatus: "unsupported",
    parseErrorCode: null,
    receivedAt,
    rawTimestampText: null,
  });
}

/**
 * Pure: no network/DB/filesystem I/O. `body` is the frame body exactly as received —
 * gzip-compressed bytes are detected and transparently decompressed. Every code path
 * returns at least one child; a totally unparseable body still yields exactly one
 * synthetic `malformed` child (docs/ARCHITECTURE.md §5 / CLAUDE.md "never silently drop").
 */
export function parseTdFrame(body: Buffer, options: ParseTdFrameOptions): ParsedTdFrame {
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
    parsed = JSON.parse(text);
  } catch {
    return {
      children: [
        makeSyntheticMalformed("invalid_json", options.receivedAt, {
          note: "body was not valid JSON",
          textSnippet: text.slice(0, 2000),
        }),
      ],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      children: [
        makeSyntheticMalformed("not_an_array", options.receivedAt, {
          note: "body was valid JSON but not an array",
          value: parsed,
        }),
      ],
    };
  }

  if (parsed.length === 0) {
    return {
      children: [
        makeSyntheticMalformed("empty_array", options.receivedAt, {
          note: "body was an empty JSON array",
        }),
      ],
    };
  }

  return {
    children: parsed.map((child, index) => classifyChild(child, index, options.receivedAt)),
  };
}
