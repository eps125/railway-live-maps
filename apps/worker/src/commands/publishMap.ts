import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPool } from "@railway/database";
import { validateMapDocument, compileMapDocument, MapDocumentSchema } from "@railway/map-schema";
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
 * first"). Validates + compiles via @railway/map-schema, then inserts a new immutable
 * map_version, closing out whichever version was previously open-ended for this map so the
 * database's no-overlap exclusion constraint (migration 0009) stays satisfied.
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
  const bundle = compileMapDocument(doc);
  const canonicalJson = JSON.stringify(doc);
  const checksum = createHash("sha256").update(canonicalJson).digest("hex");

  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");

      const mapResult = await client.query<{ id: string }>(
        `insert into map (slug, name)
         values ($1, $2)
         on conflict (slug) do update set name = excluded.name
         returning id`,
        [slug, doc.map.name],
      );
      const mapId = mapResult.rows[0]?.id;
      if (!mapId) {
        throw new Error("Expected map upsert to return an id");
      }

      const versionNumberResult = await client.query<{ next: string }>(
        `select coalesce(max(version_number), 0) + 1 as next from map_version where map_id = $1`,
        [mapId],
      );
      const versionNumber = Number(versionNumberResult.rows[0]?.next ?? "1");

      // Close out whichever version was previously open-ended, so the new version's
      // [effective_from, null) range doesn't overlap it.
      await client.query(
        `update map_version set effective_to = $2 where map_id = $1 and effective_to is null`,
        [mapId, effectiveFrom],
      );

      const inserted = await client.query<{ id: string; version_number: number }>(
        `insert into map_version (
           map_id, version_number, canonical_document, compiled_runtime_bundle,
           effective_from, effective_to, published_by, schema_version, checksum
         ) values ($1,$2,$3,$4,$5,null,$6,$7,$8)
         returning id, version_number`,
        [
          mapId,
          versionNumber,
          canonicalJson,
          JSON.stringify(bundle),
          effectiveFrom,
          "publish-map-cli",
          doc.schemaVersion,
          checksum,
        ],
      );

      await client.query("commit");
      console.log(
        `Published "${slug}" v${inserted.rows[0]?.version_number} (map_version id ${inserted.rows[0]?.id}), effective from ${effectiveFrom.toISOString()}`,
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
