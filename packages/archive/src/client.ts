import { S3Client } from "@aws-sdk/client-s3";

export interface ArchiveClientOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted S3-compatible stores require path-style addressing. */
  forcePathStyle?: boolean;
}

export function createArchiveClient(options: ArchiveClientOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
}
