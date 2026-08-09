import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerEditorDraftRoutes } from "./drafts.js";
import { registerEditorValidateRoutes } from "./validate.js";
import { registerEditorPublishRoutes } from "./publish.js";
import { registerEditorDiffRoutes } from "./diff.js";
import { registerEditorBindingDiagnosticsRoutes } from "./bindingDiagnostics.js";
import { registerEditorStateRoutes } from "./state.js";
import { registerEditorBerthActionRoutes } from "./berthActions.js";

export interface EditorRoutesDeps {
  pool: Pool;
}

/**
 * All Milestone 11/12 editor routes (docs/API_CONTRACT.md §4), registered as one group so
 * `server.ts` can gate the whole set behind `EDITOR_ENABLED` in a single place — when disabled,
 * none of these routes exist at all (`docs/ARCHITECTURE.md` §12: "disabled... by default").
 */
export async function registerEditorRoutes(
  app: FastifyInstance,
  deps: EditorRoutesDeps,
): Promise<void> {
  await registerEditorDraftRoutes(app, deps);
  await registerEditorValidateRoutes(app, deps);
  await registerEditorPublishRoutes(app, deps);
  await registerEditorDiffRoutes(app, deps);
  await registerEditorBindingDiagnosticsRoutes(app, deps);
  await registerEditorStateRoutes(app, deps);
  await registerEditorBerthActionRoutes(app, deps);
}
