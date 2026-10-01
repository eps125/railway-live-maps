import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  flattenAssembledMap,
  isAssembledMap,
  MapDocumentSchema,
  moduleSlugs,
  validateMapDocument,
  type MapDocument,
  type ModuleIssue,
  type ValidationIssue,
} from "@railway/map-schema";
import { publishMapVersion, type PublishMapVersionResult } from "@railway/map-publish";
import type { Queryable } from "@railway/database";

/**
 * Milestone 85 (docs/adr/0019): the server side of map modules — publishing a module, assembling
 * a map from its modules, and republishing every map assembled from a module when it changes.
 */

export type MapKind = "map" | "module";

export async function mapKindForSlug(db: Queryable, slug: string): Promise<MapKind | null> {
  const { rows } = await db.query<{ kind: MapKind }>(`select kind from map where slug = $1`, [
    slug,
  ]);
  return rows[0]?.kind ?? null;
}

export interface PublishedModule {
  slug: string;
  mapId: string;
  moduleVersionId: string;
  versionNumber: number;
  doc: MapDocument;
}

/** The latest published version of each named module (missing ones are simply absent). */
export async function loadPublishedModules(
  db: Queryable,
  slugs: string[],
): Promise<Map<string, PublishedModule>> {
  if (slugs.length === 0) return new Map();
  const { rows } = await db.query<{
    slug: string;
    map_id: string;
    id: string;
    version_number: number;
    canonical_document: MapDocument;
  }>(
    `select distinct on (m.id) m.slug, m.id::text as map_id, mmv.id::text, mmv.version_number,
            mmv.canonical_document
       from map m
       join map_module_version mmv on mmv.map_id = m.id
      where m.kind = 'module' and m.slug = any($1::text[])
      order by m.id, mmv.version_number desc`,
    [slugs],
  );
  return new Map(
    rows.map((row) => [
      row.slug,
      {
        slug: row.slug,
        mapId: row.map_id,
        moduleVersionId: row.id,
        versionNumber: row.version_number,
        doc: MapDocumentSchema.parse(row.canonical_document),
      },
    ]),
  );
}

/** Each named module's current draft (falling back to its latest published version). */
export async function loadModuleDrafts(
  db: Queryable,
  slugs: string[],
): Promise<Map<string, MapDocument>> {
  if (slugs.length === 0) return new Map();
  const { rows } = await db.query<{ slug: string; doc: MapDocument }>(
    `select m.slug,
            coalesce(d.canonical_document,
                     (select mmv.canonical_document from map_module_version mmv
                       where mmv.map_id = m.id order by mmv.version_number desc limit 1)) as doc
       from map m
       left join map_draft d on d.slug = m.slug
      where m.kind = 'module' and m.slug = any($1::text[])`,
    [slugs],
  );
  const out = new Map<string, MapDocument>();
  for (const row of rows) {
    const parsed = MapDocumentSchema.safeParse(row.doc);
    if (parsed.success) out.set(row.slug, parsed.data);
  }
  return out;
}

export function moduleIssuesAsValidation(issues: ModuleIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({ code: issue.code, message: issue.message }));
}

export interface Assembly {
  flattened: MapDocument;
  issues: ModuleIssue[];
  moduleVersions: Array<{ slug: string; moduleVersionId: string; versionNumber: number }>;
}

/** An assembled map's source, flattened with each module's latest *published* version — what a
 * publish of it would produce. */
export async function assembleFromPublished(db: Queryable, source: MapDocument): Promise<Assembly> {
  const modules = await loadPublishedModules(db, moduleSlugs(source));
  const result = flattenAssembledMap(
    source,
    new Map([...modules].map(([slug, module]) => [slug, module.doc])),
  );
  return {
    flattened: result.doc,
    issues: result.issues,
    moduleVersions: [...modules.values()].map((module) => ({
      slug: module.slug,
      moduleVersionId: module.moduleVersionId,
      versionNumber: module.versionNumber,
    })),
  };
}

/** For the editor's preview and test mode: flattened with each module's *draft*. A plain map is
 * returned unchanged. */
export async function previewDocument(db: Queryable, doc: MapDocument): Promise<MapDocument> {
  if (!isAssembledMap(doc)) return doc;
  const drafts = await loadModuleDrafts(db, moduleSlugs(doc));
  return flattenAssembledMap(doc, drafts).doc;
}

/** Publishes an assembled map: the flattened document as the version, with its source and the
 * module versions it was built from. Inside the caller's transaction. */
export async function publishAssembledVersion(
  client: Queryable,
  input: {
    slug: string;
    source: MapDocument;
    assembly: Assembly;
    effectiveFrom: Date;
    publishedBy: string;
  },
): Promise<PublishMapVersionResult> {
  const result = await publishMapVersion(client, {
    slug: input.slug,
    doc: input.assembly.flattened,
    effectiveFrom: input.effectiveFrom,
    publishedBy: input.publishedBy,
  });
  await client.query(
    `update map_version set source_document = $2::jsonb, module_versions = $3::jsonb where id = $1`,
    [
      result.mapVersionId,
      JSON.stringify(input.source),
      JSON.stringify(input.assembly.moduleVersions),
    ],
  );
  return result;
}

/** Records a module's new published version. Inside the caller's transaction. */
export async function publishModuleVersion(
  client: Queryable,
  input: { slug: string; doc: MapDocument; publishedBy: string },
): Promise<{ mapId: string; moduleVersionId: string; versionNumber: number }> {
  const canonical = JSON.stringify(input.doc);
  const { rows } = await client.query<{ id: string; map_id: string; version_number: number }>(
    `insert into map_module_version (map_id, version_number, canonical_document, published_by, checksum)
     select m.id,
            coalesce((select max(version_number) from map_module_version where map_id = m.id), 0) + 1,
            $2::jsonb, $3, $4
       from map m where m.slug = $1 and m.kind = 'module'
     returning id::text, map_id::text, version_number`,
    [
      input.slug,
      canonical,
      input.publishedBy,
      createHash("sha256").update(canonical).digest("hex"),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error(`No module "${input.slug}"`);
  return { mapId: row.map_id, moduleVersionId: row.id, versionNumber: row.version_number };
}

export interface RepublishOutcome {
  slug: string;
  ok: boolean;
  versionNumber?: number;
  errors?: ValidationIssue[];
}

/** The slugs of maps whose *current published version* is assembled from `moduleSlug`. */
export async function mapsUsingModule(db: Queryable, moduleSlug: string): Promise<string[]> {
  const { rows } = await db.query<{ slug: string }>(
    `select m.slug
       from map m
       join map_version mv on mv.map_id = m.id
      where mv.effective_from <= now() and (mv.effective_to is null or mv.effective_to > now())
        and mv.source_document is not null
        and (mv.source_document -> 'modules') @> jsonb_build_array(jsonb_build_object('slug', $1::text))
      order by lower(m.name)`,
    [moduleSlug],
  );
  return rows.map((row) => row.slug);
}

/** Maps whose current *draft* uses `moduleSlug` (published or not) — for "used by" and deletion. */
export async function draftsUsingModule(db: Queryable, moduleSlug: string): Promise<string[]> {
  const { rows } = await db.query<{ slug: string }>(
    `select d.slug from map_draft d
      where (d.canonical_document -> 'modules') @> jsonb_build_array(jsonb_build_object('slug', $1::text))
      order by d.slug`,
    [moduleSlug],
  );
  return rows.map((row) => row.slug);
}

/**
 * Republishes one map from what it last published: an assembled map is re-flattened from its
 * published source with the latest published modules; a plain map republishes the same document
 * (recompiled). The draft is untouched, so unpublished edits to the map itself stay unpublished.
 * A map whose assembly no longer works (e.g. a join was removed) is left as it is and reported.
 */
export async function republishMap(
  client: Queryable,
  slug: string,
  publishedBy: string,
): Promise<RepublishOutcome> {
  const { rows } = await client.query<{
    canonical_document: MapDocument;
    source_document: MapDocument | null;
  }>(
    `select mv.canonical_document, mv.source_document
       from map_version mv join map m on m.id = mv.map_id
      where m.slug = $1 and mv.effective_from <= now()
        and (mv.effective_to is null or mv.effective_to > now())
      order by mv.effective_from desc limit 1`,
    [slug],
  );
  const current = rows[0];
  if (!current)
    return { slug, ok: false, errors: [{ code: "not_published", message: "Never published" }] };

  const source = MapDocumentSchema.parse(current.source_document ?? current.canonical_document);
  if (isAssembledMap(source)) {
    const assembly = await assembleFromPublished(client, source);
    const structural = validateMapDocument(assembly.flattened);
    const errors = [...moduleIssuesAsValidation(assembly.issues), ...structural.errors];
    if (errors.length > 0) return { slug, ok: false, errors };
    const result = await publishAssembledVersion(client, {
      slug,
      source,
      assembly,
      effectiveFrom: new Date(0),
      publishedBy,
    });
    return { slug, ok: true, versionNumber: result.versionNumber };
  }
  const structural = validateMapDocument(source);
  if (!structural.valid) return { slug, ok: false, errors: structural.errors };
  const result = await publishMapVersion(client, {
    slug,
    doc: source,
    effectiveFrom: new Date(0),
    publishedBy,
  });
  return { slug, ok: true, versionNumber: result.versionNumber };
}

/** Runs `fn` in its own transaction. */
export async function inTransaction<T>(
  pool: Pool,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * After a module publish: republish every map currently assembled from it, each in its own
 * transaction so one map that no longer fits can't hold back the others.
 */
export async function cascadeModulePublish(
  pool: Pool,
  moduleSlug: string,
  publishedBy: string,
): Promise<RepublishOutcome[]> {
  const slugs = await mapsUsingModule(pool, moduleSlug);
  const outcomes: RepublishOutcome[] = [];
  for (const slug of slugs) {
    try {
      outcomes.push(await inTransaction(pool, (client) => republishMap(client, slug, publishedBy)));
    } catch (error) {
      outcomes.push({
        slug,
        ok: false,
        errors: [{ code: "republish_failed", message: (error as Error).message }],
      });
    }
  }
  return outcomes;
}
