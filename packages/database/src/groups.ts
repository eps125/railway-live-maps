import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 83 (docs/adr/0018): user groups. A group decides what its members can *see* (which
 * restricted maps); a user's role still decides what they can *do*. Membership lives in
 * `app_user_group`; a user may belong to several groups.
 */

export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
}

interface UserGroupRow {
  id: string;
  name: string;
  description: string | null;
  member_count: string;
  created_at: Date;
}

function toUserGroup(row: UserGroupRow): UserGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: Number(row.member_count),
    createdAt: row.created_at,
  };
}

export class DuplicateGroupNameError extends Error {
  constructor(name: string) {
    super(`A group named "${name}" already exists`);
    this.name = "DuplicateGroupNameError";
  }
}

const GROUP_SELECT = `
  select g.id::text, g.name, g.description, g.created_at,
         (select count(*) from app_user_group aug where aug.group_id = g.id)::text as member_count
    from user_group g`;

export async function listGroups(db: Queryable): Promise<UserGroup[]> {
  const { rows } = await db.query<UserGroupRow>(`${GROUP_SELECT} order by lower(g.name)`);
  return rows.map(toUserGroup);
}

export async function findGroupById(db: Queryable, id: string): Promise<UserGroup | null> {
  const { rows } = await db.query<UserGroupRow>(`${GROUP_SELECT} where g.id = $1`, [id]);
  return rows[0] ? toUserGroup(rows[0]) : null;
}

export async function createGroup(
  db: Queryable,
  input: { name: string; description?: string | null },
): Promise<UserGroup> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into user_group (name, description) values ($1, $2) returning id::text`,
      [input.name.trim(), input.description?.trim() || null],
    );
    return (await findGroupById(db, rows[0]!.id))!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateGroupNameError(input.name.trim());
    throw error;
  }
}

export async function updateGroup(
  db: Queryable,
  id: string,
  input: { name?: string | undefined; description?: string | null | undefined },
): Promise<UserGroup | null> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `update user_group
          set name = coalesce($2, name),
              description = case when $3::boolean then $4 else description end,
              updated_at = now()
        where id = $1
        returning id::text`,
      [
        id,
        input.name?.trim() ?? null,
        input.description !== undefined,
        input.description?.trim() || null,
      ],
    );
    return rows[0] ? findGroupById(db, rows[0].id) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateGroupNameError(input.name?.trim() ?? "");
    throw error;
  }
}

/** Deleting a group removes its memberships and its place on any map's visibility list (FK
 * cascades). A restricted map left with no groups becomes admins-only — never public. */
export async function deleteGroup(db: Queryable, id: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `delete from user_group where id = $1 returning id`,
    [id],
  );
  return rows.length === 1;
}

/** Every user's group ids, keyed by user id (for the admin users list). */
export async function listUserGroupIds(db: Queryable): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ user_id: string; group_ids: string[] }>(
    `select user_id::text, array_agg(group_id::text order by group_id) as group_ids
       from app_user_group group by user_id`,
  );
  return new Map(rows.map((row) => [row.user_id, row.group_ids]));
}

export async function groupIdsForUser(db: Queryable, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ group_id: string }>(
    `select group_id::text from app_user_group where user_id = $1 order by group_id`,
    [userId],
  );
  return rows.map((row) => row.group_id);
}

export class UnknownGroupError extends Error {
  constructor(ids: string[]) {
    super(`Unknown group id(s): ${ids.join(", ")}`);
    this.name = "UnknownGroupError";
  }
}

/** Replaces a user's whole group membership with exactly `groupIds`. Run inside a transaction
 * when called alongside other changes. */
export async function setUserGroups(
  db: Queryable,
  userId: string,
  groupIds: string[],
): Promise<void> {
  const unique = [...new Set(groupIds)];
  await assertGroupsExist(db, unique);
  await db.query(
    `delete from app_user_group where user_id = $1 and group_id <> all($2::bigint[])`,
    [userId, unique],
  );
  await db.query(
    `insert into app_user_group (user_id, group_id)
     select $1, unnest($2::bigint[])
     on conflict do nothing`,
    [userId, unique],
  );
}

export async function assertGroupsExist(db: Queryable, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;
  if (groupIds.some((id) => !/^\d+$/.test(id))) throw new UnknownGroupError(groupIds);
  const { rows } = await db.query<{ id: string }>(
    `select id::text from user_group where id = any($1::bigint[])`,
    [groupIds],
  );
  const found = new Set(rows.map((row) => row.id));
  const missing = groupIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new UnknownGroupError(missing);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
