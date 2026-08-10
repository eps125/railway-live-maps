import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { sha256Hex, computeArchiveObjectKey, putImmutableObject } from "@railway/archive";
import { parseCorpusFileStream } from "@railway/feed-parsers";

/**
 * Milestone 7: imports a CORPUS (TIPLOC/STANOX/CRS/NLC/UIC) full extract. Much smaller than
 * SCHEDULE (docs/IMPLEMENTATION_PLAN.md: "a few tens of thousands of records"), so this upserts
 * by natural key (`tiploc`) in place rather than using a staging/swap transaction — per-row
 * `on conflict` instead. Constructed field names (`TIPLOC`/`NLC`/`STANOX`/`CRS`) per
 * `packages/feed-parsers/src/reference/parseCorpusFileStream.ts`'s own doc comment: not a
 * captured real extract.
 */
export interface ImportCorpusDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
}

export interface ImportCorpusResult {
  sourceFileImportId: string;
  alreadyImported: boolean;
  upsertedRows: number;
}

async function findOrCreateSourceFileImport(
  pool: Pool,
  checksum: string,
  archiveObjectId: string,
): Promise<{ id: string; status: string }> {
  const existing = await pool.query<{ id: string; status: string }>(
    `select id, status from source_file_import
     where source_kind = 'reference-file' and file_kind = 'corpus' and checksum_sha256 = $1`,
    [checksum],
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }
  const inserted = await pool.query<{ id: string; status: string }>(
    `insert into source_file_import (source_kind, file_kind, archive_object_id, checksum_sha256, status)
     values ('reference-file', 'corpus', $1, $2, 'in_progress')
     returning id, status`,
    [archiveObjectId, checksum],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Expected source_file_import insert to return a row");
  }
  return row;
}

function readable(body: Buffer): Readable {
  return Readable.from(body);
}

interface LocationRow {
  tiploc: string;
  stanox: string | null;
  crs: string | null;
  nlc: string | null;
  name: string | null;
  rawSourceJson: unknown;
}

interface UnhandledRow {
  seqNoInFile: number;
  raw: unknown;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** Rows per multi-row INSERT — mirrors smartImporter.ts's fix for the same "one query per
 * record" slowness (34,194 SMART records took minutes; CORPUS is smaller but the same class
 * of problem at scale). */
const BATCH_SIZE = 500;

async function insertLocationBatch(
  pool: Pool,
  batch: LocationRow[],
  sourceFileImportId: string,
): Promise<void> {
  const params: unknown[] = [];
  const valuesClauses: string[] = [];
  for (const row of batch) {
    const base = params.length;
    valuesClauses.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},'CORPUS',$${base + 6},$${base + 7})`,
    );
    params.push(
      row.tiploc,
      row.stanox,
      row.crs,
      row.nlc,
      row.name,
      sourceFileImportId,
      JSON.stringify(row.rawSourceJson),
    );
  }

  await pool.query(
    `insert into location_reference (tiploc, stanox, crs, nlc, name, source, source_file_import_id, raw_source_json)
     values ${valuesClauses.join(",")}
     on conflict (tiploc) do update
     set stanox = excluded.stanox, crs = excluded.crs, nlc = excluded.nlc, name = excluded.name,
         source_file_import_id = excluded.source_file_import_id, raw_source_json = excluded.raw_source_json,
         imported_at = now()`,
    params,
  );
}

async function insertUnhandledBatch(
  pool: Pool,
  batch: UnhandledRow[],
  sourceFileImportId: string,
): Promise<void> {
  const params: unknown[] = [];
  const valuesClauses: string[] = [];
  for (const row of batch) {
    const base = params.length;
    valuesClauses.push(`($${base + 1},'corpus_missing_tiploc',$${base + 2},$${base + 3})`);
    params.push(sourceFileImportId, row.seqNoInFile, JSON.stringify(row.raw));
  }

  await pool.query(
    `insert into import_unhandled_record (source_file_import_id, record_type, seq_no_in_file, raw_json)
     values ${valuesClauses.join(",")}`,
    params,
  );
}

/** Imports a CORPUS full extract already saved at `filePath`. Idempotent: reimporting
 * byte-identical content short-circuits without touching `location_reference` again. */
export async function runImportCorpus(
  deps: ImportCorpusDeps,
  filePath: string,
): Promise<ImportCorpusResult> {
  const body = await readFile(filePath);
  const checksum = sha256Hex(body);
  const receivedAt = new Date();
  const objectKey = computeArchiveObjectKey({
    namespace: "corpus",
    contentSha256: checksum,
    date: receivedAt,
  });

  await putImmutableObject({
    client: deps.archiveClient,
    bucket: deps.archiveBucket,
    key: objectKey,
    body,
    contentType: "application/json",
  });

  const archiveObjectId = await deps.pool
    .query<{ id: string }>(
      `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
       values ($1, $2, $3, $4, 'reference-file')
       on conflict (object_key) do update set object_key = excluded.object_key
       returning id`,
      [objectKey, deps.archiveBucket, checksum, body.length],
    )
    .then((r) => r.rows[0]?.id);
  if (!archiveObjectId) {
    throw new Error("Failed to upsert raw_archive_object for CORPUS file");
  }

  const sourceFileImport = await findOrCreateSourceFileImport(deps.pool, checksum, archiveObjectId);
  if (sourceFileImport.status === "completed") {
    return { sourceFileImportId: sourceFileImport.id, alreadyImported: true, upsertedRows: 0 };
  }

  // Deduplicated by tiploc, last-write-wins — mirrors smartImporter.ts's rationale: a single
  // multi-row INSERT can't ON CONFLICT DO UPDATE the same target row twice, so any duplicate
  // TIPLOC lines within one file must be resolved in memory before batching.
  const locationsByTiploc = new Map<string, LocationRow>();
  const unhandled: UnhandledRow[] = [];

  try {
    for await (const record of parseCorpusFileStream(readable(body))) {
      const raw = record.raw as Record<string, unknown>;
      const tiploc = typeof raw.TIPLOC === "string" ? raw.TIPLOC.trim() : "";
      if (!tiploc) {
        unhandled.push({ seqNoInFile: record.seqNoInFile, raw: record.raw });
        continue;
      }
      locationsByTiploc.set(tiploc, {
        tiploc,
        stanox: typeof raw.STANOX === "string" ? raw.STANOX : null,
        crs: typeof raw.CRS === "string" ? raw.CRS : null,
        nlc: typeof raw.NLC === "string" ? raw.NLC : null,
        name: typeof raw.NLCDESC === "string" ? raw.NLCDESC : null,
        rawSourceJson: record.raw,
      });
    }

    for (const batch of chunk(unhandled, BATCH_SIZE)) {
      await insertUnhandledBatch(deps.pool, batch, sourceFileImport.id);
    }
    for (const batch of chunk([...locationsByTiploc.values()], BATCH_SIZE)) {
      await insertLocationBatch(deps.pool, batch, sourceFileImport.id);
    }
  } catch (error) {
    await deps.pool.query(
      "update source_file_import set status = 'failed', error_summary = $2 where id = $1",
      [sourceFileImport.id, (error as Error).message],
    );
    throw error;
  }

  const upsertedRows = locationsByTiploc.size;
  await deps.pool.query(
    `update source_file_import
     set status = 'completed', completed_at = now(), is_active = true, row_counts = $2
     where id = $1`,
    [sourceFileImport.id, JSON.stringify({ upsertedRows })],
  );

  return { sourceFileImportId: sourceFileImport.id, alreadyImported: false, upsertedRows };
}
