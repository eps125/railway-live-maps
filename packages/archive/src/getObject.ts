import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

export interface GetImmutableObjectOptions {
  client: S3Client;
  bucket: string;
  key: string;
}

/** Reads back a previously-archived object's exact original bytes. Used when something needs
 * to be reprocessed from the untouched original (e.g. a parser fix reparsing frames that were
 * archived correctly but parsed wrong at the time) — the archive is the durable source of truth
 * raw_feed_event is derived from, not the other way around. */
export async function getImmutableObject(options: GetImmutableObjectOptions): Promise<Buffer> {
  const result = await options.client.send(
    new GetObjectCommand({ Bucket: options.bucket, Key: options.key }),
  );
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`Archive object ${options.bucket}/${options.key} has no body`);
  }
  return Buffer.from(bytes);
}
