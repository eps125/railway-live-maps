import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { runImportSchedule } from "../schedule/scheduleImporter.js";

/** `import-schedule <path>` — imports an already-downloaded SCHEDULE full extract file
 * (docs/IMPLEMENTATION_PLAN.md Milestone 7). Shared by `download-schedule` once a file has
 * been fetched. */
export async function runImportScheduleCommand(config: Config, argv: string[]): Promise<void> {
  const filePath = argv[0];
  if (!filePath) {
    throw new Error("import-schedule requires a file path argument");
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const archiveClient = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  try {
    const result = await runImportSchedule(
      { pool, archiveClient, archiveBucket: config.RAW_ARCHIVE_BUCKET },
      filePath,
    );
    console.log("import-schedule complete:", result);
  } finally {
    await pool.end();
  }
}
