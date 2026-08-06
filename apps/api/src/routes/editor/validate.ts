import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { MapDocumentSchema } from "@railway/map-schema";
import { validateDraftInContext } from "../../editor/validateWithContext.js";

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

      const result = await validateDraftInContext(pool, parsed.data);
      return result;
    },
  );
}
