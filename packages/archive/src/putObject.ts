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
