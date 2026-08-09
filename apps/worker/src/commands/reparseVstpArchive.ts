import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { reparseVstpArchive } from "../vstp/reparseArchive.js";

/** `reparse-vstp-archive [--dry-run]` — one-off repair for VSTP raw_feed_event rows written by
 * a parser version that assumed the wrong wire format (XML instead of JSON). Re-derives each
 * row from its untouched archived original, in place. Run `project-vstp --rebuild` afterward to
 * actually project the now-correctly-parsed backlog into schedules. */
export async function runReparseVstpArchive(config: Config, argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  const archiveClient = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  try {
    const summary = await reparseVstpArchive(pool, archiveClient, { dryRun });
    console.log(`reparse-vstp-archive complete${dryRun ? " (dry run)" : ""}:`, summary);
    if (!dryRun && summary.changed > 0) {
      console.log("Now run: project-vstp --rebuild");
    }
  } finally {
    await pool.end();
  }
}
