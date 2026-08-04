import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { reconcileArchive, type ReconcileMode } from "../archive/reconcile.js";

function parseMode(argv: string[]): ReconcileMode {
  const flag = argv.find((arg) => arg.startsWith("--mode="));
  const value = flag?.split("=")[1] ?? "quick";
  if (value !== "quick" && value !== "deep") {
    throw new Error(`Invalid --mode "${value}", expected "quick" or "deep"`);
  }
  return value;
}

/** Exits non-zero only for missing/corrupt DB-indexed objects — orphans are reported, not fatal. */
export async function runReconcileArchive(config: Config, argv: string[]): Promise<void> {
  const mode = parseMode(argv);
  const pool = createPool({ connectionString: config.DATABASE_URL });
  const client = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  try {
    const result = await reconcileArchive(pool, client, config.RAW_ARCHIVE_BUCKET, { mode });
    console.log(
      `Reconciled ${result.checkedCount} archive objects (mode=${mode}): ` +
        `${result.missingKeys.length} missing, ${result.corruptKeys.length} corrupt, ` +
        `${result.orphanKeys.length} orphaned S3 objects.`,
    );
    if (result.missingKeys.length > 0) {
      console.error("Missing (DB row, no S3 object):", result.missingKeys);
    }
    if (result.corruptKeys.length > 0) {
      console.error("Corrupt (checksum mismatch):", result.corruptKeys);
    }
    if (result.orphanKeys.length > 0) {
      console.warn(
        "Orphaned (S3 object, no DB row — expected from a crash before commit):",
        result.orphanKeys,
      );
    }
    if (result.missingKeys.length > 0 || result.corruptKeys.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
