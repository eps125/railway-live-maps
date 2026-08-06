import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { downloadToTempFile } from "../lib/downloadToTempFile.js";
import { runImportCorpus } from "../reference/corpusImporter.js";

/** `download-corpus` — fetches the current CORPUS full extract and imports it via the same
 * `runImportCorpus` the file-path `import-corpus` command uses. Refuses to start unless
 * SCHEDULE_DOWNLOAD_ENABLED=true (CORPUS/SMART share the SCHEDULE download gate — all three
 * are the same "reference/file download" concern, not independently live-critical feeds like
 * TD/VSTP/TRUST) and NR_USERNAME/NR_PASSWORD are set. */
export async function runDownloadCorpus(config: Config): Promise<void> {
  if (!config.SCHEDULE_DOWNLOAD_ENABLED) {
    throw new Error(
      "download-corpus requires SCHEDULE_DOWNLOAD_ENABLED=true. Use `import-corpus <path>` " +
        "against a manually-obtained file first — see docs/IMPLEMENTATION_PLAN.md Milestone 7.",
    );
  }
  if (!config.NR_USERNAME || !config.NR_PASSWORD) {
    throw new Error("download-corpus requires NR_USERNAME/NR_PASSWORD (or the _FILE variants)");
  }

  const filePath = await downloadToTempFile({
    url: config.NR_CORPUS_DOWNLOAD_URL,
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
    const result = await runImportCorpus(
      { pool, archiveClient, archiveBucket: config.RAW_ARCHIVE_BUCKET },
      filePath,
    );
    console.log("download-corpus complete:", result);
  } finally {
    await pool.end();
  }
}
