import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { sha256Hex } from "@railway/archive";
import { reconcileArchive } from "./reconcile.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

// See ../td/recorder.integration.test.ts for why S3 is faked (no MinIO in this sandbox).
class FakeReconcileS3Client {
  objects = new Map<string, Buffer>();

  send = async (command: {
    constructor: { name: string };
    input?: { Key?: string; Prefix?: string };
  }): Promise<unknown> => {
    const name = command.constructor.name;
    const key = command.input?.Key ?? "";

    if (name === "HeadObjectCommand") {
      if (!this.objects.has(key)) {
        throw Object.assign(new Error("not found"), { name: "NotFound" });
      }
      return {};
    }
    if (name === "GetObjectCommand") {
      const body = this.objects.get(key);
      if (!body) {
        throw Object.assign(new Error("not found"), { name: "NoSuchKey" });
      }
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    if (name === "ListObjectsV2Command") {
      const prefix = command.input?.Prefix ?? "";
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
      return { Contents: keys.map((Key) => ({ Key })) };
    }
    throw new Error(`Unsupported command in FakeReconcileS3Client: ${name}`);
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

async function insertArchiveObjectRow(key: string, contentSha256: string): Promise<void> {
  await pool.query(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'railway-raw-test', $2, 10, 'broker-frame')`,
    [key, contentSha256],
  );
}

describe("reconcileArchive (integration)", () => {
  const prefix = `raw/td/reconcile-test-${randomUUID()}`;

  afterAll(async () => {
    await pool.query("delete from raw_archive_object where object_key like $1", [`${prefix}%`]);
    await pool.end();
  });

  it("reports ok for a present, checksum-matching object; missing for an absent one; orphan for an S3-only object", async () => {
    const client = new FakeReconcileS3Client();

    const okKey = `${prefix}/ok.bin`;
    const okBody = Buffer.from("present and correct");
    client.objects.set(okKey, okBody);
    await insertArchiveObjectRow(okKey, sha256Hex(okBody));

    const missingKey = `${prefix}/missing.bin`;
    await insertArchiveObjectRow(missingKey, sha256Hex(Buffer.from("never uploaded")));

    const orphanKey = `${prefix}/orphan.bin`;
    client.objects.set(orphanKey, Buffer.from("uploaded but no db row (crash before commit)"));

    const result = await reconcileArchive(pool, client as unknown as S3Client, "railway-raw-test", {
      mode: "quick",
    });

    expect(result.missingKeys).toContain(missingKey);
    expect(result.missingKeys).not.toContain(okKey);
    expect(result.orphanKeys).toContain(orphanKey);
    expect(result.orphanKeys).not.toContain(okKey);
  });

  it("deep mode detects a checksum mismatch as corrupt", async () => {
    const client = new FakeReconcileS3Client();

    const key = `${prefix}/corrupt.bin`;
    const recordedSha256 = sha256Hex(Buffer.from("original content"));
    client.objects.set(key, Buffer.from("tampered content"));
    await insertArchiveObjectRow(key, recordedSha256);

    const result = await reconcileArchive(pool, client as unknown as S3Client, "railway-raw-test", {
      mode: "deep",
    });

    expect(result.corruptKeys).toContain(key);
  });
});
