import {
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { sha256Hex } from "@railway/archive";
import type { Pool } from "pg";

export type ReconcileMode = "quick" | "deep";

export interface ReconcileArchiveOptions {
  mode: ReconcileMode;
}

export interface ReconcileArchiveResult {
  checkedCount: number;
  /** Severe: a DB index row exists but the object is missing from S3 (docs/ARCHITECTURE.md §5:
   * "must trigger an alert and block acknowledgement"). */
  missingKeys: string[];
  /** Severe (deep mode only): the object exists but its recomputed checksum doesn't match. */
  corruptKeys: string[];
  /** Benign: an S3 object with no matching DB row — expected from a crash between the S3 PUT
   * and the transaction commit that inserts the raw_archive_object row. */
  orphanKeys: string[];
}

interface ArchiveObjectRow {
  id: string;
  object_key: string;
  content_sha256: string;
}

async function checkOneObject(
  client: S3Client,
  bucket: string,
  row: ArchiveObjectRow,
  mode: ReconcileMode,
): Promise<"ok" | "missing" | "corrupt"> {
  try {
    if (mode === "quick") {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: row.object_key }));
      return "ok";
    }

    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: row.object_key }),
    );
    const body = await response.Body?.transformToByteArray();
    if (!body) {
      return "missing";
    }
    const actualSha256 = sha256Hex(Buffer.from(body));
    return actualSha256 === row.content_sha256 ? "ok" : "corrupt";
  } catch (error) {
    if (isNotFoundError(error)) {
      return "missing";
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return name === "NotFound" || name === "NoSuchKey";
}

async function listAllArchiveKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) {
        keys.add(object.Key);
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

/**
 * Two-directional archive/DB reconciliation (docs/IMPLEMENTATION_PLAN.md M2). DB→S3 finds
 * missing/corrupt objects (severe — the function still returns rather than throwing so the
 * caller can report everything before deciding an exit code). S3→DB finds orphans (benign).
 */
export async function reconcileArchive(
  pool: Pool,
  client: S3Client,
  bucket: string,
  options: ReconcileArchiveOptions,
): Promise<ReconcileArchiveResult> {
  const rows = (
    await pool.query<ArchiveObjectRow>(
      "select id, object_key, content_sha256 from raw_archive_object",
    )
  ).rows;

  const missingKeys: string[] = [];
  const corruptKeys: string[] = [];

  for (const row of rows) {
    const outcome = await checkOneObject(client, bucket, row, options.mode);
    if (outcome === "missing") {
      missingKeys.push(row.object_key);
    } else if (outcome === "corrupt") {
      corruptKeys.push(row.object_key);
    }
    await pool.query(
      "update raw_archive_object set verified_at = now(), verification_status = $2 where id = $1",
      [row.id, outcome],
    );
  }

  const knownKeys = new Set(rows.map((row) => row.object_key));
  const s3Keys = await listAllArchiveKeys(client, bucket, "raw/");
  const orphanKeys = [...s3Keys].filter((key) => !knownKeys.has(key));

  return { checkedCount: rows.length, missingKeys, corruptKeys, orphanKeys };
}
