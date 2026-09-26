import { gunzip } from "node:zlib";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { MapDocumentSchema } from "@railway/map-schema";
import { apiError, parseLimit } from "../../lib/queryRange.js";
import { getOrSeedDraft, getDraft } from "../../editor/draftStore.js";

/** 2026-09-26 (owner: "saving is taking absolutely ages"): the editor gzips a draft save —
 * nearly all of a ~3 s Carlisle save was uploading ~300 KB of JSON, and map JSON compresses about
 * tenfold. A dedicated content type rather than `Content-Encoding`, so anything between the
 * browser and here passes it through untouched rather than trying to decode it. */
export const GZIP_DRAFT_CONTENT_TYPE = "application/x-rlm-draft-gzip";
/** Compressed upload limit, and the most a compressed draft may expand to. */
const GZIP_DRAFT_BODY_LIMIT = 4 * 1024 * 1024;
const GZIP_DRAFT_MAX_EXPANDED = 32 * 1024 * 1024;

export interface EditorDraftRoutesDeps {
  pool: Pool;
}

interface PutDraftBody {
  canonicalDocument: unknown;
  expectedRevision: number;
  updatedBy?: string;
  comment?: string;
  commandSummary?: unknown;
}

function draftResponse(row: {
  slug: string;
  map_id: string | null;
  canonical_document: unknown;
  revision: number;
  base_map_version_id: string | null;
  updated_by: string | null;
  updated_at: Date;
  created_at: Date;
}) {
  return {
    slug: row.slug,
    mapId: row.map_id,
    canonicalDocument: row.canonical_document,
    revision: row.revision,
    baseMapVersionId: row.base_map_version_id,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Milestone 11/12 (docs/API_CONTRACT.md §4): `GET`/`PUT /api/v1/editor/maps/{slug}/draft`,
 * `GET /api/v1/editor/maps/{slug}/revisions`. `PUT` only requires the body to parse against
 * `MapDocumentSchema`'s basic shape — it deliberately does NOT run `validateMapDocument`'s
 * stricter structural checks (duplicate IDs, missing bindings, etc.), since "autosave draft
 * without publishing" (docs/MAP_EDITOR_SPEC.md §7) must keep working through transiently
 * invalid in-progress editing states. The stricter gate lives on `/validate` and `/publish`.
 */
export async function registerEditorDraftRoutes(
  app: FastifyInstance,
  deps: EditorDraftRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.addContentTypeParser(
    GZIP_DRAFT_CONTENT_TYPE,
    { parseAs: "buffer", bodyLimit: GZIP_DRAFT_BODY_LIMIT },
    (_request, payload, done) => {
      gunzip(payload as Buffer, { maxOutputLength: GZIP_DRAFT_MAX_EXPANDED }, (error, expanded) => {
        if (error) {
          done(Object.assign(new Error("Could not decompress the draft"), { statusCode: 400 }));
          return;
        }
        try {
          done(null, JSON.parse(expanded.toString("utf8")));
        } catch {
          done(Object.assign(new Error("The draft is not valid JSON"), { statusCode: 400 }));
        }
      });
    },
  );

  app.get<{ Params: { slug: string } }>("/api/v1/editor/maps/:slug/draft", async (request) => {
    const draft = await getOrSeedDraft(pool, request.params.slug);
    return draftResponse(draft);
  });

  app.put<{ Params: { slug: string }; Body: PutDraftBody }>(
    "/api/v1/editor/maps/:slug/draft",
    async (request, reply) => {
      const { slug } = request.params;
      const body = request.body;

      if (typeof body?.expectedRevision !== "number") {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "expectedRevision (number) is required");
      }

      const parsed = MapDocumentSchema.safeParse(body.canonicalDocument);
      if (!parsed.success) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "canonicalDocument failed schema validation", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      // Ensure a draft row exists (first save for a never-before-drafted slug) before
      // attempting the optimistic-lock update below. Checked without reading the document back:
      // the usual case is an existing draft, and reading ~300 KB just to discard it cost ~70 ms.
      const exists = await pool.query("select 1 from map_draft where slug = $1", [slug]);
      if (exists.rowCount === 0) await getOrSeedDraft(pool, slug);
      const documentJson = JSON.stringify(parsed.data);

      const client = await pool.connect();
      try {
        await client.query("begin");
        const updated = await client.query<{
          id: string;
          slug: string;
          map_id: string | null;
          revision: number;
          base_map_version_id: string | null;
          updated_by: string | null;
          updated_at: Date;
          created_at: Date;
        }>(
          // Everything but the document: the response echoes the document just validated.
          `update map_draft
           set canonical_document = $1, revision = revision + 1, updated_by = $2, updated_at = now()
           where slug = $3 and revision = $4
           returning id, slug, map_id, revision, base_map_version_id, updated_by, updated_at,
                     created_at`,
          [documentJson, body.updatedBy ?? null, slug, body.expectedRevision],
        );

        if (updated.rows.length === 0) {
          await client.query("rollback");
          const current = await getDraft(pool, slug);
          reply.code(409);
          return apiError(
            "DRAFT_REVISION_CONFLICT",
            "The draft has changed since your expectedRevision — reload and retry",
            { currentRevision: current?.revision ?? null },
          );
        }

        const row = updated.rows[0]!;
        await client.query(
          `insert into map_draft_revision (map_draft_id, revision, canonical_document, command_summary, author, comment)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            row.id,
            row.revision,
            documentJson,
            body.commandSummary ? JSON.stringify(body.commandSummary) : null,
            body.updatedBy ?? null,
            body.comment ?? null,
          ],
        );

        await client.query("commit");
        return draftResponse({ ...row, canonical_document: parsed.data });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { limit?: string; before?: string } }>(
    "/api/v1/editor/maps/:slug/revisions",
    async (request, reply) => {
      const draft = await getDraft(pool, request.params.slug);
      if (!draft) {
        reply.code(404);
        return apiError("DRAFT_NOT_FOUND", `No draft exists for "${request.params.slug}" yet`);
      }

      const limit = parseLimit(request.query.limit);
      const before = request.query.before ? Number(request.query.before) : undefined;

      const result = await pool.query<{
        revision: number;
        author: string | null;
        comment: string | null;
        created_at: Date;
      }>(
        `select revision, author, comment, created_at
         from map_draft_revision
         where map_draft_id = $1 ${before !== undefined ? "and revision < $3" : ""}
         order by revision desc
         limit $2`,
        before !== undefined ? [draft.id, limit, before] : [draft.id, limit],
      );

      return {
        revisions: result.rows.map((row) => ({
          revision: row.revision,
          author: row.author,
          comment: row.comment,
          createdAt: row.created_at.toISOString(),
        })),
        nextBefore:
          result.rows.length === limit ? result.rows[result.rows.length - 1]!.revision : null,
      };
    },
  );
}
