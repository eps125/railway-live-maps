import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { sha256Hex } from "@railway/archive";
import { resolveReferenceFixturesDir } from "@railway/feed-parsers";
import { runImportSmart } from "./smartImporter.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

class FakeS3Client {
  send = async (): Promise<Record<string, never>> => {
    return {};
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new FakeS3Client() as unknown as S3Client;
const bucket = "railway-raw-test";
const fixturesDir = resolveReferenceFixturesDir();
const deps = { pool, archiveClient, archiveBucket: bucket };

async function resetFixtureState(fileName: string): Promise<void> {
  const body = await readFile(join(fixturesDir, fileName));
  const checksum = sha256Hex(body);
  const existing = await pool.query<{ id: string; archive_object_id: string }>(
    `select id, archive_object_id from source_file_import
     where source_kind = 'reference-file' and file_kind = 'smart' and checksum_sha256 = $1`,
    [checksum],
  );
  for (const row of existing.rows) {
    await pool.query("delete from import_unhandled_record where source_file_import_id = $1", [
      row.id,
    ]);
    await pool.query("delete from source_file_import where id = $1", [row.id]);
    await pool.query("delete from raw_archive_object where id = $1", [row.archive_object_id]);
  }
}

describe("runImportSmart (integration)", () => {
  beforeAll(async () => {
    await resetFixtureState("smart-small.json");
    await pool.query("delete from smart_berth_step where td_area = 'ZZ'");
  });

  afterAll(async () => {
    await pool.query("delete from smart_berth_step where td_area = 'ZZ'");
    await pool.end();
  });

  it("upserts smart_berth_step rows, including a row with an empty to_berth", async () => {
    const result = await runImportSmart(deps, join(fixturesDir, "smart-small.json"));

    expect(result.alreadyImported).toBe(false);
    expect(result.upsertedRows).toBe(2);

    const rows = await pool.query<{ from_berth: string | null; to_berth: string | null }>(
      "select from_berth, to_berth from smart_berth_step where td_area = 'ZZ' order by from_berth",
    );
    expect(rows.rows).toEqual([
      { from_berth: "0001", to_berth: "0002" },
      { from_berth: "0002", to_berth: null },
    ]);
  });

  it("reimporting byte-identical content is a safe no-op (idempotent by natural key)", async () => {
    const before = await pool.query<{ n: number }>(
      "select count(*)::int as n from smart_berth_step where td_area = 'ZZ'",
    );

    const result = await runImportSmart(deps, join(fixturesDir, "smart-small.json"));
    expect(result.alreadyImported).toBe(true);

    const after = await pool.query<{ n: number }>(
      "select count(*)::int as n from smart_berth_step where td_area = 'ZZ'",
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("a whole-file JSON parse failure marks the import failed rather than partially applying", async () => {
    await resetFixtureState("smart-malformed.json");
    await expect(runImportSmart(deps, join(fixturesDir, "smart-malformed.json"))).rejects.toThrow();

    const body = await readFile(join(fixturesDir, "smart-malformed.json"));
    const checksum = sha256Hex(body);
    const row = await pool.query<{ status: string }>(
      "select status from source_file_import where source_kind = 'reference-file' and checksum_sha256 = $1",
      [checksum],
    );
    expect(row.rows[0]?.status).toBe("failed");
  });
});
