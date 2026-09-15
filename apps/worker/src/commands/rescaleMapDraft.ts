import { createPool } from "@railway/database";
import { MapDocumentSchema, rescaleMapDocument, type MapDocument } from "@railway/map-schema";
import type { Config } from "../config.js";

interface ParsedArgs {
  slug?: string | undefined;
  scale?: number | undefined;
  restore?: number | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--slug") result.slug = argv[(i += 1)];
    else if (arg === "--scale") result.scale = Number(argv[(i += 1)]);
    else if (arg === "--restore") result.restore = Number(argv[(i += 1)]);
    else if (arg === "--dry-run") result.dryRun = true;
  }
  return result;
}

const USAGE =
  "usage: rescale-map-draft --slug <slug> --scale <factor> [--dry-run]\n" +
  "   or: rescale-map-draft --slug <slug> --restore <revision> [--dry-run]";

/**
 * `rescale-map-draft` — one-shot console command (run it from the `worker` container, like
 * `publish-map`). Two modes on one command so undo is always the same tool as the change:
 *
 *  - `--scale <factor>`: multiplies every coordinate in the draft's current document by `factor`
 *    via `rescaleMapDocument` (`@railway/map-schema`) — see that function's doc comment for
 *    exactly what does and doesn't scale. Pairs with a `MAP_STYLE.rowPitch`/`weldTolerance`
 *    change of the same factor (2026-09-15, docs/adr/0004 addendum).
 *  - `--restore <revision>`: puts a past `map_draft_revision` snapshot back verbatim as a new
 *    revision. This is the exact undo path — an inverse `--scale` would drift on floating point,
 *    and only works for undoing a scale specifically, whereas `--restore` undoes *any* draft
 *    change back to a known-good point. `map_draft_revision` already keeps a full document
 *    snapshot on every save (migration 0011, retained >= 90 days per docs/PROJECT_SPEC.md §9), so
 *    no new storage is needed for this.
 *
 * Both modes go through the same optimistic-style update the editor's own `PUT .../draft` uses
 * (bump `revision`, insert the new `map_draft_revision` row) so this shows up in the draft's
 * normal history exactly like a manual edit would, and re-validates the result against
 * `MapDocumentSchema` before writing anything. `--dry-run` reports what revision the change would
 * land on without writing.
 *
 * Does not publish — review the result in the editor and publish as usual (published versions
 * stay immutable, CLAUDE.md rule 11; this only ever touches the draft).
 */
export async function runRescaleMapDraft(config: Config, argv: string[]): Promise<void> {
  const { slug, scale, restore, dryRun } = parseArgs(argv);

  if (!slug || (scale === undefined) === (restore === undefined)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
    console.error("rescale-map-draft: --scale must be a positive number");
    process.exitCode = 1;
    return;
  }
  if (restore !== undefined && (!Number.isInteger(restore) || restore <= 0)) {
    console.error("rescale-map-draft: --restore must be a positive integer revision number");
    process.exitCode = 1;
    return;
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");

      const draftResult = await client.query<{
        id: string;
        canonical_document: MapDocument;
        revision: number;
      }>(`select id, canonical_document, revision from map_draft where slug = $1 for update`, [
        slug,
      ]);
      const draft = draftResult.rows[0];
      if (!draft) {
        console.error(
          `rescale-map-draft: no draft exists for slug "${slug}" yet — open it in the editor at least once first`,
        );
        await client.query("rollback");
        process.exitCode = 1;
        return;
      }

      let candidate: unknown;
      let summary: string;
      if (restore !== undefined) {
        const snapshot = await client.query<{ canonical_document: MapDocument }>(
          `select canonical_document from map_draft_revision where map_draft_id = $1 and revision = $2`,
          [draft.id, restore],
        );
        const found = snapshot.rows[0];
        if (!found) {
          console.error(
            `rescale-map-draft: "${slug}" has no revision ${restore} in its history (currently at ${draft.revision})`,
          );
          await client.query("rollback");
          process.exitCode = 1;
          return;
        }
        candidate = found.canonical_document;
        summary = `restore of revision ${restore}`;
      } else {
        candidate = rescaleMapDocument(draft.canonical_document, scale!);
        summary = `x${scale} rescale`;
      }

      const parsed = MapDocumentSchema.safeParse(candidate);
      if (!parsed.success) {
        console.error(
          `rescale-map-draft: result failed schema validation (${parsed.error.issues.length} issue(s)):`,
        );
        for (const issue of parsed.error.issues) {
          console.error(`  ${issue.path.join(".")}: ${issue.message}`);
        }
        await client.query("rollback");
        process.exitCode = 1;
        return;
      }

      if (dryRun) {
        console.log(
          `rescale-map-draft: --dry-run — "${slug}" is at revision ${draft.revision}; ${summary} ` +
            `would write revision ${draft.revision + 1}. No changes written.`,
        );
        await client.query("rollback");
        return;
      }

      const updated = await client.query<{ revision: number }>(
        `update map_draft
         set canonical_document = $1, revision = revision + 1, updated_by = $2, updated_at = now()
         where id = $3
         returning revision`,
        [JSON.stringify(parsed.data), "rescale-map-draft-cli", draft.id],
      );
      const newRevision = updated.rows[0]!.revision;

      await client.query(
        `insert into map_draft_revision (map_draft_id, revision, canonical_document, command_summary, author, comment)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          draft.id,
          newRevision,
          JSON.stringify(parsed.data),
          JSON.stringify({ type: "rescale-map-draft", summary }),
          "rescale-map-draft-cli",
          summary,
        ],
      );

      await client.query("commit");
      console.log(
        `rescale-map-draft: "${slug}" ${summary} — revision ${draft.revision} -> ${newRevision}. ` +
          (restore === undefined
            ? `To undo exactly: rescale-map-draft --slug ${slug} --restore ${draft.revision}`
            : "Review in the editor and publish when ready."),
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
