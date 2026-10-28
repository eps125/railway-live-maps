import type { Queryable } from "./checkpoint.js";
import { PERMISSION_KEYS, isCodeGrantable, isPermission, type Permission } from "./permissions.js";

/**
 * Milestone 99 (docs/adr/0022): user types. Each type has a set of permissions (its column of the
 * permission matrix). Two are built in: `public` (every anonymous visitor) and `admin` (every
 * permission, including ones added later). Every user has exactly one type; an access code may
 * grant one.
 */

export type UserTypeSystemKey = "public" | "admin";

export interface UserType {
  id: string;
  systemKey: UserTypeSystemKey | null;
  name: string;
  description: string | null;
  sortOrder: number;
  grantsAll: boolean;
  /** Every permission the type holds (all of them for Admin). */
  permissions: Permission[];
  userCount: number;
  codeCount: number;
}

interface UserTypeRow {
  id: string;
  system_key: UserTypeSystemKey | null;
  name: string;
  description: string | null;
  sort_order: number;
  grants_all: boolean;
  permissions: string[];
  user_count: string;
  code_count: string;
}

function toUserType(row: UserTypeRow): UserType {
  return {
    id: row.id,
    systemKey: row.system_key,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    grantsAll: row.grants_all,
    permissions: row.grants_all ? [...PERMISSION_KEYS] : row.permissions.filter(isPermission),
    userCount: Number(row.user_count),
    codeCount: Number(row.code_count),
  };
}

const TYPE_SELECT = `
  select t.id::text, t.system_key, t.name, t.description, t.sort_order, t.grants_all,
         coalesce((select array_agg(p.permission order by p.permission)
                     from user_type_permission p where p.user_type_id = t.id), '{}') as permissions,
         (select count(*) from app_user u where u.user_type_id = t.id)::text as user_count,
         (select count(*) from access_code c where c.user_type_id = t.id)::text as code_count
    from user_type t`;

export async function listUserTypes(db: Queryable): Promise<UserType[]> {
  const { rows } = await db.query<UserTypeRow>(`${TYPE_SELECT} order by t.sort_order, t.id`);
  return rows.map(toUserType);
}

export async function findUserType(db: Queryable, id: string): Promise<UserType | null> {
  if (!/^\d+$/.test(id)) return null;
  const { rows } = await db.query<UserTypeRow>(`${TYPE_SELECT} where t.id = $1`, [id]);
  return rows[0] ? toUserType(rows[0]) : null;
}

export async function findUserTypeByName(db: Queryable, name: string): Promise<UserType | null> {
  const { rows } = await db.query<UserTypeRow>(`${TYPE_SELECT} where lower(t.name) = lower($1)`, [
    name.trim(),
  ]);
  return rows[0] ? toUserType(rows[0]) : null;
}

/** The whole matrix, for the API's in-process cache: each type's permissions, and which type is
 * the public one. */
export interface PermissionMatrix {
  publicTypeId: string;
  byType: Map<string, ReadonlySet<Permission>>;
}

export async function loadPermissionMatrix(db: Queryable): Promise<PermissionMatrix> {
  const types = await listUserTypes(db);
  const publicType = types.find((t) => t.systemKey === "public");
  if (!publicType) throw new Error("The public user type is missing (migration 0056)");
  return {
    publicTypeId: publicType.id,
    byType: new Map(types.map((t) => [t.id, new Set(t.permissions)])),
  };
}

export class DuplicateUserTypeNameError extends Error {
  constructor(name: string) {
    super(`A user type named "${name}" already exists`);
    this.name = "DuplicateUserTypeNameError";
  }
}

export class SystemUserTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemUserTypeError";
  }
}

export class UserTypeInUseError extends Error {
  constructor(
    readonly userCount: number,
    readonly codeCount: number,
  ) {
    super(
      `This user type is still used by ${userCount} user(s) and ${codeCount} access code(s); move them to another type first`,
    );
    this.name = "UserTypeInUseError";
  }
}

/** Thrown when a change would leave no active user able to manage users and user types — a
 * self-hosted, single-owner app has no other way back in. */
export class LastManagerGuardError extends Error {
  constructor(action: string) {
    super(
      `Refusing to ${action}: no active user would be left able to manage users and user types`,
    );
    this.name = "LastManagerGuardError";
  }
}

/** The permissions that together let a user recover any other lock-out. */
export const MANAGER_PERMISSIONS: readonly Permission[] = ["admin.users", "admin.user_types"];

export function isManagerSet(permissions: Iterable<Permission>): boolean {
  const set = new Set(permissions);
  return MANAGER_PERMISSIONS.every((p) => set.has(p));
}

/**
 * Active users who can manage users and user types, after a hypothetical change: one user left
 * out (deleted, deactivated or moved), and/or one type's permissions replaced.
 */
export async function countActiveManagers(
  db: Queryable,
  options: {
    excludingUserId?: string | null;
    typeOverride?: { typeId: string; isManager: boolean };
  },
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `select count(*)::text as count
       from app_user u join user_type t on t.id = u.user_type_id
      where u.is_active
        and ($1::bigint is null or u.id <> $1::bigint)
        and case when t.id = $2::bigint then $3::boolean
                 else t.grants_all or (
                   select count(*) from user_type_permission p
                    where p.user_type_id = t.id and p.permission = any($4::text[])) = $5
            end`,
    [
      options.excludingUserId ?? null,
      options.typeOverride?.typeId ?? null,
      options.typeOverride?.isManager ?? false,
      MANAGER_PERMISSIONS,
      MANAGER_PERMISSIONS.length,
    ],
  );
  return Number(rows[0]?.count ?? "0");
}

export interface UserTypeInput {
  name: string;
  description?: string | null | undefined;
  sortOrder?: number | undefined;
  permissions: Permission[];
}

async function setTypePermissions(
  db: Queryable,
  typeId: string,
  permissions: Permission[],
): Promise<void> {
  await db.query(`delete from user_type_permission where user_type_id = $1`, [typeId]);
  await db.query(
    `insert into user_type_permission (user_type_id, permission)
     select $1, unnest($2::text[])`,
    [typeId, [...new Set(permissions)]],
  );
}

/** Run inside a transaction. */
export async function createUserType(db: Queryable, input: UserTypeInput): Promise<UserType> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into user_type (name, description, sort_order)
       values ($1, $2, coalesce($3, (select coalesce(max(sort_order), 0) + 1 from user_type
                                       where system_key is distinct from 'admin')))
       returning id::text`,
      [input.name.trim(), input.description?.trim() || null, input.sortOrder ?? null],
    );
    const id = rows[0]!.id;
    await setTypePermissions(db, id, input.permissions);
    return (await findUserType(db, id))!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateUserTypeNameError(input.name.trim());
    throw error;
  }
}

export interface UserTypeUpdate {
  name?: string | undefined;
  description?: string | null | undefined;
  sortOrder?: number | undefined;
  permissions?: Permission[] | undefined;
}

/**
 * Changes a type. Admin cannot be changed at all; the public type can have its permissions and
 * description changed but keeps its name. Refuses a permission change that would leave nobody
 * able to manage users and user types. Run inside a transaction.
 */
export async function updateUserType(
  db: Queryable,
  id: string,
  update: UserTypeUpdate,
): Promise<UserType | null> {
  const current = await findUserType(db, id);
  if (!current) return null;
  if (current.systemKey === "admin") {
    throw new SystemUserTypeError(
      "The Admin type always has every permission and cannot be changed",
    );
  }
  if (
    current.systemKey === "public" &&
    update.name !== undefined &&
    update.name.trim() !== current.name
  ) {
    throw new SystemUserTypeError("The public type cannot be renamed");
  }
  if (update.permissions !== undefined) {
    if (current.codeCount > 0 && update.permissions.some((p) => !isCodeGrantable(p))) {
      throw new SystemUserTypeError(
        `This type is granted by ${current.codeCount} access code(s), so it cannot hold admin permissions`,
      );
    }
    const managers = await countActiveManagers(db, {
      typeOverride: { typeId: id, isManager: isManagerSet(update.permissions) },
    });
    if (managers === 0) throw new LastManagerGuardError("change these permissions");
  }
  try {
    await db.query(
      `update user_type
          set name = coalesce($2, name),
              description = case when $3::boolean then $4 else description end,
              sort_order = coalesce($5, sort_order),
              updated_at = now()
        where id = $1`,
      [
        id,
        update.name?.trim() ?? null,
        update.description !== undefined,
        update.description?.trim() || null,
        update.sortOrder ?? null,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateUserTypeNameError(update.name!.trim());
    throw error;
  }
  if (update.permissions !== undefined) await setTypePermissions(db, id, update.permissions);
  return findUserType(db, id);
}

/** Deletes a type no user or code uses. Returns false for an unknown type. */
export async function deleteUserType(db: Queryable, id: string): Promise<boolean> {
  const current = await findUserType(db, id);
  if (!current) return false;
  if (current.systemKey)
    throw new SystemUserTypeError(`The ${current.name} type cannot be deleted`);
  if (current.userCount > 0 || current.codeCount > 0) {
    throw new UserTypeInUseError(current.userCount, current.codeCount);
  }
  await db.query(`delete from user_type where id = $1`, [id]);
  return true;
}

/** Milestone 84's site mode, read from the public type (docs/adr/0022 §5). */
export async function getPublicSiteMode(db: Queryable): Promise<"open" | "code_required"> {
  const { rows } = await db.query<{ open: boolean }>(
    `select exists (
       select 1 from user_type_permission p join user_type t on t.id = p.user_type_id
        where t.system_key = 'public' and p.permission = 'site.view') as open`,
  );
  return rows[0]?.open ? "open" : "code_required";
}

/** The Site settings shortcut: `open` gives guests `site.view` and `maps.view_public` (their
 * other permissions are set in the matrix); `code_required` takes `site.view` away. */
export async function setPublicSiteMode(
  db: Queryable,
  mode: "open" | "code_required",
): Promise<void> {
  if (mode === "open") {
    await db.query(
      `insert into user_type_permission (user_type_id, permission)
       select t.id, p from user_type t, unnest(array['site.view', 'maps.view_public']) as p
        where t.system_key = 'public'
       on conflict do nothing`,
    );
  } else {
    await db.query(
      `delete from user_type_permission p using user_type t
        where t.id = p.user_type_id and t.system_key = 'public' and p.permission = 'site.view'`,
    );
  }
  await db.query(`update user_type set updated_at = now() where system_key = 'public'`);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
