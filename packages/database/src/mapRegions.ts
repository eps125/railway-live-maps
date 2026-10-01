import type { Queryable } from "./checkpoint.js";

/** Milestone 83 (docs/adr/0018): regions that group the public map list, in admin-set order. */

export interface MapRegion {
  id: string;
  name: string;
  sortOrder: number;
  mapCount: number;
}

interface MapRegionRow {
  id: string;
  name: string;
  sort_order: number;
  map_count: string;
}

export class DuplicateRegionNameError extends Error {
  constructor(name: string) {
    super(`A region named "${name}" already exists`);
    this.name = "DuplicateRegionNameError";
  }
}

const REGION_SELECT = `
  select r.id::text, r.name, r.sort_order,
         (select count(*) from map m where m.region_id = r.id)::text as map_count
    from map_region r`;

function toRegion(row: MapRegionRow): MapRegion {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    mapCount: Number(row.map_count),
  };
}

export async function listRegions(db: Queryable): Promise<MapRegion[]> {
  const { rows } = await db.query<MapRegionRow>(
    `${REGION_SELECT} order by r.sort_order, lower(r.name)`,
  );
  return rows.map(toRegion);
}

export async function findRegionById(db: Queryable, id: string): Promise<MapRegion | null> {
  if (!/^\d+$/.test(id)) return null;
  const { rows } = await db.query<MapRegionRow>(`${REGION_SELECT} where r.id = $1`, [id]);
  return rows[0] ? toRegion(rows[0]) : null;
}

/** A new region goes to the end of the list unless a sort order is given. */
export async function createRegion(
  db: Queryable,
  input: { name: string; sortOrder?: number },
): Promise<MapRegion> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into map_region (name, sort_order)
       values ($1, coalesce($2, (select coalesce(max(sort_order), 0) + 10 from map_region)))
       returning id::text`,
      [input.name.trim(), input.sortOrder ?? null],
    );
    return (await findRegionById(db, rows[0]!.id))!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateRegionNameError(input.name.trim());
    throw error;
  }
}

export async function updateRegion(
  db: Queryable,
  id: string,
  input: { name?: string; sortOrder?: number },
): Promise<MapRegion | null> {
  if (!/^\d+$/.test(id)) return null;
  try {
    const { rows } = await db.query<{ id: string }>(
      `update map_region
          set name = coalesce($2, name), sort_order = coalesce($3, sort_order)
        where id = $1
        returning id::text`,
      [id, input.name?.trim() ?? null, input.sortOrder ?? null],
    );
    return rows[0] ? findRegionById(db, rows[0].id) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateRegionNameError(input.name?.trim() ?? "");
    throw error;
  }
}

/** Maps in a deleted region become region-less ("Other") via the FK's `on delete set null`. */
export async function deleteRegion(db: Queryable, id: string): Promise<boolean> {
  if (!/^\d+$/.test(id)) return false;
  const { rows } = await db.query<{ id: string }>(
    `delete from map_region where id = $1 returning id`,
    [id],
  );
  return rows.length === 1;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
