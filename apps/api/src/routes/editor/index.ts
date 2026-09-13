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
 * `server.ts` can gate the whole set behind a single `requireRole("editor", ...)` hook, applied
 * to the encapsulated Fastify scope these are registered into (Milestone 29 — replaces the old
 * `EDITOR_ENABLED` boolean gate; `docs/ARCHITECTURE.md` §12).
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
