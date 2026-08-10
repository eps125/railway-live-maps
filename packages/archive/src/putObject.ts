import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

export interface PutImmutableObjectOptions {
  client: S3Client;
  bucket: string;
  key: string;
  body: Buffer;
  contentType?: string;
  contentEncoding?: string;
}

/**
 * Puts an object at a deterministic, content-addressed key. Idempotent: identical bytes
 * written to the same key again is a safe no-op overwrite (see computeArchiveObjectKey).
 */
export async function putImmutableObject(options: PutImmutableObjectOptions): Promise<void> {
  await options.client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      Body: options.body,
      ContentType: options.contentType,
      ContentEncoding: options.contentEncoding,
    }),
  );
}

export interface PutImmutableObjectFromFileOptions {
  client: S3Client;
  bucket: string;
  key: string;
  filePath: string;
  contentType?: string;
  contentEncoding?: string;
}

/**
 * Streaming equivalent of putImmutableObject for files too large to buffer whole in memory —
 * confirmed necessary 2026-08-10 (a real CIF SCHEDULE full extract was 3.29GB, past Node's
 * fs.readFile hard 2 GiB ceiling). Passes an explicit ContentLength alongside the Readable body
 * so the S3 client can stream the PUT directly instead of buffering the stream first to
 * compute the Content-Length header itself.
 */
export async function putImmutableObjectFromFile(
  options: PutImmutableObjectFromFileOptions,
): Promise<void> {
  const stats = await stat(options.filePath);
  await options.client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      Body: createReadStream(options.filePath),
      ContentLength: stats.size,
      ContentType: options.contentType,
      ContentEncoding: options.contentEncoding,
    }),
  );
}
