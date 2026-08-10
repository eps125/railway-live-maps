import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { sha256Hex, computeArchiveObjectKey, putImmutableObject } from "@railway/archive";
import { parseSmartFileStream } from "@railway/feed-parsers";

/**
 * Milestone 7: imports a SMART (berth-step) full extract. Same shape/trade-offs as
 * `corpusImporter.ts` — upserts by natural key in place. `smart_berth_step` has no natural
 * primary/foreign key on the wire, so a dedicated unique index was added in
 * `packages/database/migrations/0014_reference_tables.sql`
 * (`smart_berth_step_natural_key_idx` on `(td_area, from_berth, to_berth, event_type)`,
 * coalesced since those fields are legitimately absent for some record shapes) purely to make
 * reimport idempotent.
 */
export interface ImportSmartDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
}

export interface ImportSmartResult {
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
     where source_kind = 'reference-file' and file_kind = 'smart' and checksum_sha256 = $1`,
    [checksum],
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }
  const inserted = await pool.query<{ id: string; status: string }>(
    `insert into source_file_import (source_kind, file_kind, archive_object_id, checksum_sha256, status)
     values ('reference-file', 'smart', $1, $2, 'in_progress')
     returning id, status`,
    [archiveObjectId, checksum],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Expected source_file_import insert to return a row");
  }
  return row;
}

interface BerthStepRow {
  tdArea: string;
  fromBerth: string | null;
  toBerth: string | null;
  stanox: string | null;
  platform: string | null;
  eventType: string | null;
  routeIndicator: string | null;
  rawSourceJson: unknown;
}

interface UnhandledRow {
  seqNoInFile: number;
  raw: unknown;
}

/** Real natural-key duplicates exist in production SMART extracts (confirmed 2026-08-10:
 * 1,142 of 34,194 records share a (td_area, from_berth, to_berth, event_type) with another
 * record in the same file) — a single multi-row INSERT can't ON CONFLICT DO UPDATE the same
 * target row twice, so duplicates must be resolved in memory first. Keyed the same way as the
 * DB's own coalesced unique index, last-write-wins to match the previous sequential loop's
 * behavior exactly (each record's upsert would have overwritten the previous one anyway). */
function naturalKey(
  row: Pick<BerthStepRow, "tdArea" | "fromBerth" | "toBerth" | "eventType">,
): string {
  return `${row.tdArea}|${row.fromBerth ?? ""}|${row.toBerth ?? ""}|${row.eventType ?? ""}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** Rows per multi-row INSERT — keeps each statement's param count (9/row) and text size well
 * within Postgres limits while cutting ~34k sequential round trips down to a few dozen. */
const BATCH_SIZE = 500;

async function insertBerthStepBatch(
  pool: Pool,
  batch: BerthStepRow[],
  sourceFileImportId: string,
): Promise<void> {
  const params: unknown[] = [];
  const valuesClauses: string[] = [];
  for (const row of batch) {
    const base = params.length;
    valuesClauses.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`,
    );
    params.push(
      row.tdArea,
      row.fromBerth,
      row.toBerth,
      row.stanox,
      row.platform,
      row.eventType,
      row.routeIndicator,
      sourceFileImportId,
      JSON.stringify(row.rawSourceJson),
    );
  }

  await pool.query(
    `insert into smart_berth_step (
       td_area, from_berth, to_berth, stanox, platform, event_type, route_indicator,
       source_file_import_id, raw_source_json
     ) values ${valuesClauses.join(",")}
     on conflict (td_area, coalesce(from_berth, ''), coalesce(to_berth, ''), coalesce(event_type, ''))
     do update
     set stanox = excluded.stanox, platform = excluded.platform,
         route_indicator = excluded.route_indicator,
         source_file_import_id = excluded.source_file_import_id,
         raw_source_json = excluded.raw_source_json, imported_at = now()`,
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
    valuesClauses.push(`($${base + 1},'smart_missing_area_id',$${base + 2},$${base + 3})`);
    params.push(sourceFileImportId, row.seqNoInFile, JSON.stringify(row.raw));
  }

  await pool.query(
    `insert into import_unhandled_record (source_file_import_id, record_type, seq_no_in_file, raw_json)
     values ${valuesClauses.join(",")}`,
    params,
  );
}

/** Imports a SMART full extract already saved at `filePath`. Idempotent: reimporting
 * byte-identical content short-circuits without touching `smart_berth_step` again. */
export async function runImportSmart(
  deps: ImportSmartDeps,
  filePath: string,
): Promise<ImportSmartResult> {
  const body = await readFile(filePath);
  const checksum = sha256Hex(body);
  const receivedAt = new Date();
  const objectKey = computeArchiveObjectKey({
    namespace: "smart",
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
    throw new Error("Failed to upsert raw_archive_object for SMART file");
  }

  const sourceFileImport = await findOrCreateSourceFileImport(deps.pool, checksum, archiveObjectId);
  if (sourceFileImport.status === "completed") {
    return { sourceFileImportId: sourceFileImport.id, alreadyImported: true, upsertedRows: 0 };
  }

  // Confirmed against a real production SMART full extract (2026-08-10, 34,194 records,
  // 194 distinct TD areas): the wire field is `TD`, not `AREAID` — this project's own
  // fixture (constructed from public documentation, not a captured real extract) assumed
  // the wrong name, so every real record was silently routed to import_unhandled_record
  // as 'smart_missing_area_id' and smart_berth_step was never actually populated. Same
  // gap class as the VSTP XML/JSON and TRUST signallingId fixes.
  const berthStepsByKey = new Map<string, BerthStepRow>();
  const unhandled: UnhandledRow[] = [];

  try {
    for await (const record of parseSmartFileStream(Readable.from(body))) {
      const raw = record.raw as Record<string, unknown>;
      const tdArea = typeof raw.TD === "string" ? raw.TD.trim() : "";
      if (!tdArea) {
        unhandled.push({ seqNoInFile: record.seqNoInFile, raw: record.raw });
        continue;
      }
      const row: BerthStepRow = {
        tdArea,
        fromBerth:
          typeof raw.FROMBERTH === "string" && raw.FROMBERTH.length > 0 ? raw.FROMBERTH : null,
        toBerth: typeof raw.TOBERTH === "string" && raw.TOBERTH.length > 0 ? raw.TOBERTH : null,
        stanox: typeof raw.STANOX === "string" ? raw.STANOX : null,
        platform: typeof raw.PLATFORM === "string" ? raw.PLATFORM : null,
        eventType: typeof raw.EVENT === "string" && raw.EVENT.length > 0 ? raw.EVENT : null,
        routeIndicator: typeof raw.ROUTE === "string" && raw.ROUTE.length > 0 ? raw.ROUTE : null,
        rawSourceJson: record.raw,
      };
      // Last-write-wins on a duplicate natural key — see naturalKey()'s doc comment.
      berthStepsByKey.set(naturalKey(row), row);
    }

    for (const batch of chunk(unhandled, BATCH_SIZE)) {
      await insertUnhandledBatch(deps.pool, batch, sourceFileImport.id);
    }
    for (const batch of chunk([...berthStepsByKey.values()], BATCH_SIZE)) {
      await insertBerthStepBatch(deps.pool, batch, sourceFileImport.id);
    }
  } catch (error) {
    await deps.pool.query(
      "update source_file_import set status = 'failed', error_summary = $2 where id = $1",
      [sourceFileImport.id, (error as Error).message],
    );
    throw error;
  }

  const upsertedRows = berthStepsByKey.size;
  await deps.pool.query(
    `update source_file_import
     set status = 'completed', completed_at = now(), is_active = true, row_counts = $2
     where id = $1`,
    [sourceFileImport.id, JSON.stringify({ upsertedRows })],
  );

  return { sourceFileImportId: sourceFileImport.id, alreadyImported: false, upsertedRows };
}
