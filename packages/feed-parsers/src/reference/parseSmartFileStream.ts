import type { Readable } from "node:stream";

/**
 * SMART (docs/REFERENCES.md's Reference Data wiki link) full extracts are supplied as one JSON
 * document — `{"BERTHDATA": [ {...}, {...}, ... ]}`. Same shape/streaming trade-offs as
 * `parseCorpusFileStream.ts`. Confirmed against a real production extract (2026-08-10, 34,194
 * records) — the `BERTHDATA` envelope shape here is correct as originally written; it was the
 * per-record field name assumed by `smartImporter.ts` (`AREAID` vs. the real `TD`) that was
 * wrong, not this envelope-parsing layer.
 */
export interface SmartFileRecord {
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

export async function* parseSmartFileStream(input: Readable): AsyncGenerator<SmartFileRecord> {
  const text = await readAll(input);
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("BERTHDATA" in parsed)) {
    throw new Error("SMART file did not contain a BERTHDATA array");
  }
  const records = (parsed as { BERTHDATA: unknown }).BERTHDATA;
  if (!Array.isArray(records)) {
    throw new Error("SMART BERTHDATA was not an array");
  }

  let seqNoInFile = 0;
  for (const raw of records) {
    seqNoInFile += 1;
    yield { seqNoInFile, raw };
  }
}
