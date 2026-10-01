import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { isAssembledMap, MapDocumentSchema, moduleSlugs } from "@railway/map-schema";
import { validateDraftInContext } from "../../editor/validateWithContext.js";
import {
  assembleFromPublished,
  loadModuleDrafts,
  loadPublishedModules,
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

      // Milestone 85: an assembled map is checked exactly as it would publish — flattened with
      // each module's latest published version — plus whether its modules fit together, and a
      // warning for each module with changes not yet published (they won't be included).
      if (!isAssembledMap(parsed.data)) return validateDraftInContext(pool, parsed.data);
      const assembly = await assembleFromPublished(pool, parsed.data);
      const result = await validateDraftInContext(pool, assembly.flattened);
      const slugs = moduleSlugs(parsed.data);
      const [published, drafts] = await Promise.all([
        loadPublishedModules(pool, slugs),
        loadModuleDrafts(pool, slugs),
      ]);
      const unpublished = slugs.filter((slug) => {
        const draft = drafts.get(slug);
        const live = published.get(slug);
        return draft && live && JSON.stringify(draft) !== JSON.stringify(live.doc);
      });
      const errors = [...moduleIssuesAsValidation(assembly.issues), ...result.errors];
      return {
        ...result,
        valid: errors.length === 0,
        errors,
        warnings: [
          ...unpublished.map((slug) => ({
            code: "module_unpublished_changes",
            message: `Module ${slug} has changes that aren't published yet — publish the module to include them`,
          })),
          ...result.warnings,
        ],
      };
    },
  );
}
