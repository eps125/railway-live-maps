import { readFile } from "node:fs/promises";
import { createPool } from "@railway/database";
import { validateMapDocument, MapDocumentSchema } from "@railway/map-schema";
import { publishMapVersion } from "@railway/map-publish";
import type { Config } from "../config.js";

function parseEffectiveFrom(argv: string[]): Date {
  const flag = argv.find((arg) => arg.startsWith("--effective-from="));
  if (!flag) return new Date();
  const value = new Date(flag.slice("--effective-from=".length));
  if (Number.isNaN(value.getTime())) {
    throw new Error(`--effective-from must be a valid ISO 8601 timestamp, got "${flag}"`);
  }
  return value;
}

/**
 * `publish-map <slug> <jsonFilePath> [--effective-from=ISO]` — the MVP publish path for
 * Milestone 5 (docs/IMPLEMENTATION_PLAN.md: "No visual editor yet; prove canonical model
 * first"), now a thin wrapper over the shared `@railway/map-publish` transaction body
 * (Milestone 11/12 extracted it so the editor's publish API route calls the exact same logic).
 * Validates via `@railway/map-schema`, then delegates persistence to `publishMapVersion`.
 */
export async function runPublishMap(config: Config, argv: string[]): Promise<void> {
  const [slug, jsonFilePath] = argv;
  if (!slug || !jsonFilePath) {
    console.error("usage: publish-map <slug> <jsonFilePath> [--effective-from=ISO]");
    process.exitCode = 1;
    return;
  }

  const effectiveFrom = parseEffectiveFrom(argv);
  const raw = await readFile(jsonFilePath, "utf8");
  const json: unknown = JSON.parse(raw);

  const validation = validateMapDocument(json);
  if (!validation.valid) {
    console.error(`Map document failed validation (${validation.errors.length} error(s)):`);
    for (const error of validation.errors) {
      console.error(`  [${error.code}] ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const doc = MapDocumentSchema.parse(json);

  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await publishMapVersion(client, {
        slug,
        doc,
        effectiveFrom,
        publishedBy: "publish-map-cli",
      });
      await client.query("commit");
      console.log(
        `Published "${slug}" v${result.versionNumber} (map_version id ${result.mapVersionId}), effective from ${effectiveFrom.toISOString()}`,
      );
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
