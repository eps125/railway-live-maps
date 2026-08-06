import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { downloadToTempFile } from "../lib/downloadToTempFile.js";
import { runImportSmart } from "../reference/smartImporter.js";

/** `download-smart` — fetches the current SMART full extract and imports it via the same
 * `runImportSmart` the file-path `import-smart` command uses. Shares the
 * SCHEDULE_DOWNLOAD_ENABLED gate with `download-corpus` — see that command's own doc comment. */
export async function runDownloadSmart(config: Config): Promise<void> {
  if (!config.SCHEDULE_DOWNLOAD_ENABLED) {
    throw new Error(
      "download-smart requires SCHEDULE_DOWNLOAD_ENABLED=true. Use `import-smart <path>` " +
        "against a manually-obtained file first — see docs/IMPLEMENTATION_PLAN.md Milestone 7.",
    );
  }
  if (!config.NR_USERNAME || !config.NR_PASSWORD) {
    throw new Error("download-smart requires NR_USERNAME/NR_PASSWORD (or the _FILE variants)");
  }

  const filePath = await downloadToTempFile({
    url: config.NR_SMART_DOWNLOAD_URL,
    username: config.NR_USERNAME,
    password: config.NR_PASSWORD,
  });

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const archiveClient = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  try {
    const result = await runImportSmart(
      { pool, archiveClient, archiveBucket: config.RAW_ARCHIVE_BUCKET },
      filePath,
    );
    console.log("download-smart complete:", result);
  } finally {
    await pool.end();
  }
}
