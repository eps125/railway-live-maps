import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { isAssembledMap, MapDocumentSchema, moduleSlugs } from "@railway/map-schema";
import { validateDraftInContext } from "../../editor/validateWithContext.js";
import {
  assembleFromPublished,
  loadModuleDrafts,
  moduleChanges,
  moduleIssuesAsValidation,
} from "../../editor/modules.js";

export interface EditorValidateRoutesDeps {
  pool: Pool;
}

interface ValidateBody {
  canonicalDocument: unknown;
}

/** `POST /api/v1/editor/maps/{slug}/validate` (docs/API_CONTRACT.md §4). The document to
 * validate is supplied in the request body (typically the client's current in-editor state,
 * which may not be saved yet) rather than re-reading the persisted draft, so the validation
 * panel can react to unsaved edits immediately. `slug` isn't otherwise used by validation
 * itself (checks are all document-intrinsic or nationwide-data-based, not slug-based) but is
 * kept in the path for a consistent editor route shape. */
export async function registerEditorValidateRoutes(
  app: FastifyInstance,
  deps: EditorValidateRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.post<{ Params: { slug: string }; Body: ValidateBody }>(
    "/api/v1/editor/maps/:slug/validate",
    async (request) => {
      const parsed = MapDocumentSchema.safeParse(request.body?.canonicalDocument);
      if (!parsed.success) {
        return {
          valid: false,
          errors: parsed.error.issues.map((issue) => ({
            code: "invalid_schema",
            message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          })),
          warnings: [],
          info: null,
        };
      }

      // Milestone 85/96: an assembled map is checked exactly as the editor's default publish
      // would produce it — flattened with each module's latest published version, except that a
      // module with unpublished changes (or never published) uses its draft, since publishing
      // offers to publish it with the map — plus whether its modules fit together, and a warning
      // for each such module.
      if (!isAssembledMap(parsed.data)) return validateDraftInContext(pool, parsed.data);
      const slugs = moduleSlugs(parsed.data);
      const pending = (await moduleChanges(pool, slugs)).filter(
        (change) => change.status === "changed" || change.status === "never_published",
      );
      const drafts = await loadModuleDrafts(
        pool,
        pending.map((change) => change.slug),
      );
      const assembly = await assembleFromPublished(pool, parsed.data, drafts);
      const result = await validateDraftInContext(pool, assembly.flattened);
      const errors = [...moduleIssuesAsValidation(assembly.issues), ...result.errors];
      return {
        ...result,
        valid: errors.length === 0,
        errors,
        warnings: [
          ...pending.map((change) => ({
            code: "module_unpublished_changes",
            message:
              change.status === "never_published"
                ? `Module ${change.slug} has never been published — it will be published with this map`
                : `Module ${change.slug} has changes that aren't published yet — they will be published with this map unless you choose the map only`,
          })),
          ...result.warnings,
        ],
      };
    },
  );
}
