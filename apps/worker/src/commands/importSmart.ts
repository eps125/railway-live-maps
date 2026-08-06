import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { runImportSmart } from "../reference/smartImporter.js";

/** `import-smart <path>` — imports an already-downloaded SMART full extract file
 * (docs/IMPLEMENTATION_PLAN.md Milestone 7). Shared by `download-smart` once a file has
 * been fetched. */
export async function runImportSmartCommand(config: Config, argv: string[]): Promise<void> {
  const filePath = argv[0];
  if (!filePath) {
    throw new Error("import-smart requires a file path argument");
  }

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
    console.log("import-smart complete:", result);
  } finally {
    await pool.end();
  }
}
