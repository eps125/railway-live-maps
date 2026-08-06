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

  let upsertedRows = 0;
  try {
    for await (const record of parseCorpusFileStream(readable(body))) {
      const raw = record.raw as Record<string, unknown>;
      const tiploc = typeof raw.TIPLOC === "string" ? raw.TIPLOC.trim() : "";
      if (!tiploc) {
        await deps.pool.query(
          `insert into import_unhandled_record (source_file_import_id, record_type, seq_no_in_file, raw_json)
           values ($1,'corpus_missing_tiploc',$2,$3)`,
          [sourceFileImport.id, record.seqNoInFile, JSON.stringify(record.raw)],
        );
        continue;
      }
      await deps.pool.query(
        `insert into location_reference (tiploc, stanox, crs, nlc, name, source, source_file_import_id, raw_source_json)
         values ($1,$2,$3,$4,$5,'CORPUS',$6,$7)
         on conflict (tiploc) do update
         set stanox = excluded.stanox, crs = excluded.crs, nlc = excluded.nlc, name = excluded.name,
             source_file_import_id = excluded.source_file_import_id, raw_source_json = excluded.raw_source_json,
             imported_at = now()`,
        [
          tiploc,
          typeof raw.STANOX === "string" ? raw.STANOX : null,
          typeof raw.CRS === "string" ? raw.CRS : null,
          typeof raw.NLC === "string" ? raw.NLC : null,
          typeof raw.NLCDESC === "string" ? raw.NLCDESC : null,
          sourceFileImport.id,
          JSON.stringify(record.raw),
        ],
      );
      upsertedRows += 1;
    }
  } catch (error) {
    await deps.pool.query(
      "update source_file_import set status = 'failed', error_summary = $2 where id = $1",
      [sourceFileImport.id, (error as Error).message],
    );
    throw error;
  }

  await deps.pool.query(
    `update source_file_import
     set status = 'completed', completed_at = now(), is_active = true, row_counts = $2
     where id = $1`,
    [sourceFileImport.id, JSON.stringify({ upsertedRows })],
  );

  return { sourceFileImportId: sourceFileImport.id, alreadyImported: false, upsertedRows };
}
