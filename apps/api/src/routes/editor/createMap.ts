import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError } from "../../lib/queryRange.js";
import { getOrSeedDraft } from "../../editor/draftStore.js";

export interface CreateMapRouteDeps {
  pool: Pool;
}

interface CreateMapBody {
  slug?: unknown;
  name?: unknown;
}

/** Lowercase, hyphen-separated, matching every slug already in use (`lancaster`) — no leading/
 * trailing/doubled hyphen, so it's always safe to drop straight into a `/map/{slug}` URL path
 * segment with no encoding. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Milestone 30 (docs/IMPLEMENTATION_PLAN.md): `POST /api/v1/editor/maps` — the one missing piece
 * for "add more maps". Everything else (`map`/`map_version` schema, `GET /api/v1/maps` listing,
 * the editor's draft/validate/publish flow) already supports multiple maps with no singleton
 * assumption; nothing outside test fixtures ever inserted a `map` row before this. Admin-only
 * (unlike the rest of the editor API, which any `editor`-role session can use) — registered by
 * `server.ts` in its own `requireRole("admin", ...)`-gated scope, the same encapsulated-scope
 * pattern as `routes/admin/users.ts`.
 */
export async function registerCreateMapRoute(
  app: FastifyInstance,
  deps: CreateMapRouteDeps,
): Promise<void> {
  const { pool } = deps;

  app.post<{ Body: CreateMapBody }>("/api/v1/editor/maps", async (request, reply) => {
    const { slug, name } = request.body ?? {};

    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      reply.code(400);
      return apiError(
        "VALIDATION_ERROR",
        "slug is required and must be lowercase letters, digits and single hyphens only",
      );
    }
    if (typeof name !== "string" || !name.trim()) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "name (non-empty string) is required");
    }

    const inserted = await pool.query<{ id: string }>(
      `insert into map (slug, name) values ($1, $2)
       on conflict (slug) do nothing
       returning id`,
      [slug, name],
    );
    const mapId = inserted.rows[0]?.id;
    if (!mapId) {
      reply.code(409);
      return apiError("DUPLICATE_SLUG", `A map with slug "${slug}" already exists`);
    }

    // Seed the initial empty draft now rather than waiting for the editor's first GET — keeps
    // "create a map" a single, complete admin action (the editor's own draft-seeding still works
    // the same way for every other slug, so this is just calling it a beat earlier).
    const draft = await getOrSeedDraft(pool, slug);

    reply.code(201);
    return { slug, name, mapId, draftRevision: draft.revision };
  });
}
