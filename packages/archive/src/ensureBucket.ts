import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export type EnsureBucketResult = "already-exists" | "created";

/** Idempotent: checks the bucket exists, creating it only if missing. */
export async function ensureBucket(client: S3Client, bucket: string): Promise<EnsureBucketResult> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return "already-exists";
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return "created";
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  const statusCode =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? Number(error.$metadata.httpStatusCode)
      : undefined;

  return name === "NotFound" || name === "NoSuchBucket" || statusCode === 404;
}
