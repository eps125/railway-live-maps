import { createArchiveClient, ensureBucket } from "@railway/archive";
import type { Config } from "../config.js";

export async function runEnsureArchiveBucket(config: Config): Promise<void> {
  const client = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  const result = await ensureBucket(client, config.RAW_ARCHIVE_BUCKET);
  console.log(`archive bucket "${config.RAW_ARCHIVE_BUCKET}": ${result}`);
}
