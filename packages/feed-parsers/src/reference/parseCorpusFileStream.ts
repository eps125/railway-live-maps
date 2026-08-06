import type { Readable } from "node:stream";

/**
 * CORPUS (docs/REFERENCES.md's Reference Data wiki link) full extracts are supplied as one
 * JSON document — `{"TIPLOCDATA": [ {...}, {...}, ... ]}` — not line-delimited like SCHEDULE's
 * extract. Constructed from the publicly documented format, not a captured real extract (same
 * caveat as `parseVstpFrame.ts`/`parseScheduleFileStream.ts`).
 *
 * Deliberately buffers the whole stream before parsing (CORPUS/SMART extracts are far smaller
 * than SCHEDULE's — a few tens of thousands of location/berth records, not hundreds of
 * thousands of schedules) rather than line-streaming; still exposed as an async generator for
 * interface consistency with `parseScheduleFileStream`.
 */
export interface CorpusFileRecord {
  seqNoInFile: number;
  raw: unknown;
}

async function readAll(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Throws if the file isn't valid JSON or doesn't have the expected `TIPLOCDATA` array — there
 * is no meaningful per-record recovery when the top-level document itself is broken; the
 * caller (the importer) records this as a whole-file failure on `source_file_import`, per
 * CLAUDE.md's "never silently discard," rather than this function inventing a fallback shape. */
export async function* parseCorpusFileStream(input: Readable): AsyncGenerator<CorpusFileRecord> {
  const text = await readAll(input);
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("TIPLOCDATA" in parsed)) {
    throw new Error("CORPUS file did not contain a TIPLOCDATA array");
  }
  const records = (parsed as { TIPLOCDATA: unknown }).TIPLOCDATA;
  if (!Array.isArray(records)) {
    throw new Error("CORPUS TIPLOCDATA was not an array");
  }

  let seqNoInFile = 0;
  for (const raw of records) {
    seqNoInFile += 1;
    yield { seqNoInFile, raw };
  }
}
