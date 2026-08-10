import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { putImmutableObjectFromFile } from "./putObject.js";

async function streamToString(stream: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("putImmutableObjectFromFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railway-archive-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("streams the file's real content and its actual on-disk size as ContentLength, never buffering it into an in-memory Buffer first", async () => {
    const filePath = join(dir, "large-ish.jsonl");
    const content = "some file content that stands in for a multi-gigabyte real extract";
    await writeFile(filePath, content);

    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;

    await putImmutableObjectFromFile({
      client,
      bucket: "test-bucket",
      key: "raw/schedule/2026/08/10/abc.bin",
      filePath,
      contentType: "application/x-ndjson",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input.Bucket).toBe("test-bucket");
    expect(command.input.Key).toBe("raw/schedule/2026/08/10/abc.bin");
    expect(command.input.ContentLength).toBe(Buffer.byteLength(content));
    expect(command.input.ContentType).toBe("application/x-ndjson");
    await expect(streamToString(command.input.Body)).resolves.toBe(content);
  });
});
