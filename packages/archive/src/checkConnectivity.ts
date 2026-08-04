import { ListBucketsCommand, type S3Client } from "@aws-sdk/client-s3";

/** Verifies the archive endpoint/credentials are reachable, without touching any specific bucket. */
export async function checkArchiveConnectivity(client: S3Client): Promise<void> {
  await client.send(new ListBucketsCommand({}));
}
