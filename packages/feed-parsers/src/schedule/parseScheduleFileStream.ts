import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

/**
 * The SCHEDULE full extract's official JSON format (docs/REFERENCES.md's SCHEDULE wiki link)
 * is one JSON object per line (JSONL), each with a single top-level wrapper key identifying
 * the record type — constructed from the publicly documented format, not a captured real
 * extract (same M0 fixture-gap caveat as `packages/feed-parsers/src/vstp/parseVstpFrame.ts`).
 *
 * Deliberately async-generator/stream-based rather than a whole-buffer parse like
 * `parseTdFrame` — full extracts can be hundreds of MB / hundreds of thousands of records, so
 * buffering the whole file would be wasteful. Still pure in the sense that matters: no DB/
 * network I/O, only reads the `Readable` it's given.
 */
export type ScheduleFileRecordType =
  "header" | "schedule" | "tiploc" | "association" | "trailer" | "unknown" | "malformed";

export interface ScheduleFileRecord {
  /** 1-based line number in the file — used as `import_unhandled_record.seq_no_in_file`. */
  seqNoInFile: number;
  recordType: ScheduleFileRecordType;
  /** The parsed line's single wrapper-key payload (e.g. the object under `JsonScheduleV1`) for
   * recognized types; the whole parsed line for `unknown`; `{ rawLine }` for `malformed`. */
  raw: unknown;
  parseErrorCode: string | null;
}

const RECORD_TYPE_BY_WRAPPER_KEY: Record<string, ScheduleFileRecordType> = {
  JsonTimetableV1: "header",
  JsonScheduleV1: "schedule",
  TiplocV1: "tiploc",
  AssociationV1: "association",
  EOF: "trailer",
};

/** Pure (beyond reading `input`): classifies each line by its single wrapper key, exactly
 * mirroring `parseTdFrame`'s "unrecognized-but-well-formed wrapper key → retained, never
 * dropped" rule and its "one synthetic malformed record for a line that isn't valid JSON"
 * fallback. */
export async function* parseScheduleFileStream(
  input: Readable,
): AsyncGenerator<ScheduleFileRecord> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let seqNoInFile = 0;

  for await (const line of rl) {
    seqNoInFile += 1;
    if (line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      yield {
        seqNoInFile,
        recordType: "malformed",
        raw: { rawLine: line.slice(0, 2000) },
        parseErrorCode: "invalid_json",
      };
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      yield {
        seqNoInFile,
        recordType: "malformed",
        raw: parsed,
        parseErrorCode: "line_not_an_object",
      };
      continue;
    }

    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length !== 1) {
      yield {
        seqNoInFile,
        recordType: "unknown",
        raw: parsed,
        parseErrorCode: "unexpected_wrapper_key_count",
      };
      continue;
    }

    const wrapperKey = keys[0] as string;
    const recordType = RECORD_TYPE_BY_WRAPPER_KEY[wrapperKey];
    if (!recordType) {
      // Structurally fine JSON, semantically unrecognized wrapper key: retained, never dropped.
      yield { seqNoInFile, recordType: "unknown", raw: parsed, parseErrorCode: null };
      continue;
    }

    yield {
      seqNoInFile,
      recordType,
      raw: (parsed as Record<string, unknown>)[wrapperKey],
      parseErrorCode: null,
    };
  }
}
