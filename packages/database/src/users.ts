import bcrypt from "bcryptjs";
import type { Queryable } from "./checkpoint.js";
import { countActiveManagers, isManagerSet, LastManagerGuardError } from "./userTypes.js";
import { isPermission } from "./permissions.js";

/**
 * Milestone 29 (docs/IMPLEMENTATION_PLAN.md): shared user CRUD + password hashing, used by both
 * `apps/api` (login) and `apps/worker` (the `manage-users` bootstrap/admin CLI) — see
 * `migrations/0029_app_user.sql` for why this lives here rather than as a second copy in each app.
 *
 * Milestone 99 (docs/adr/0022): a user's capabilities come from their user type, not a fixed
 * role. `app_user.role` is still written (`admin` for the Admin type, `editor` otherwise) so the
 * previous release can be rolled back to, but nothing reads it.
 */

export interface AppUser {
  id: string;
  username: string;
  userTypeId: string;
  userTypeName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface AppUserWithHash extends AppUser {
  passwordHash: string;
}

interface AppUserRow {
  id: string;
  username: string;
  password_hash: string;
  user_type_id: string;
  user_type_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

function toAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    username: row.username,
    userTypeId: row.user_type_id,
    userTypeName: row.user_type_name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

const USER_SELECT = `
  select u.id::text, u.username, u.password_hash, u.user_type_id::text, t.name as user_type_name,
         u.is_active, u.created_at, u.updated_at, u.last_login_at
    from app_user u join user_type t on t.id = u.user_type_id`;

const BCRYPT_COST = 12;
// A precomputed hash of a value nobody will ever supply. Comparing a login attempt for a
// nonexistent username against this (instead of short-circuiting) keeps the response time close
// to that of a real user with a wrong password, so a login attempt doesn't cheaply reveal which
// usernames exist.
const DUMMY_HASH = bcrypt.hashSync("rlm-no-such-user-dummy-hash", BCRYPT_COST);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH);
}

/** Usernames are stored and looked up case-insensitively (normalized to lowercase) so
 * "Matt"/"matt" can't silently become two different accounts. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function findUserByUsername(
  db: Queryable,
  username: string,
): Promise<AppUserWithHash | null> {
  const { rows } = await db.query<AppUserRow>(`${USER_SELECT} where u.username = $1`, [
    normalizeUsername(username),
  ]);
  const row = rows[0];
  return row ? { ...toAppUser(row), passwordHash: row.password_hash } : null;
}

export async function findUserById(db: Queryable, id: string): Promise<AppUser | null> {
  const { rows } = await db.query<AppUserRow>(`${USER_SELECT} where u.id = $1`, [id]);
  const row = rows[0];
  return row ? toAppUser(row) : null;
}

export async function listUsers(db: Queryable): Promise<AppUser[]> {
  const { rows } = await db.query<AppUserRow>(`${USER_SELECT} order by u.created_at asc`);
  return rows.map(toAppUser);
}

/** Thrown for a user type that doesn't exist, or that a user can't have (the public type). */
export class InvalidUserTypeError extends Error {
  constructor(id: string) {
    super(`No user type ${id} can be given to a user`);
    this.name = "InvalidUserTypeError";
  }
}

async function typeForUser(
  db: Queryable,
  userTypeId: string,
): Promise<{ grantsAll: boolean; isManager: boolean }> {
  if (!/^\d+$/.test(userTypeId)) throw new InvalidUserTypeError(userTypeId);
  const { rows } = await db.query<{ grants_all: boolean; permissions: string[] }>(
    `select t.grants_all,
            coalesce((select array_agg(p.permission) from user_type_permission p
                       where p.user_type_id = t.id), '{}') as permissions
       from user_type t where t.id = $1 and t.system_key is distinct from 'public'`,
    [userTypeId],
  );
  const row = rows[0];
  if (!row) throw new InvalidUserTypeError(userTypeId);
  return {
    grantsAll: row.grants_all,
    isManager: row.grants_all || isManagerSet(row.permissions.filter(isPermission)),
  };
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`A user named "${username}" already exists`);
    this.name = "DuplicateUsernameError";
  }
}

export async function createUser(
  db: Queryable,
  input: { username: string; password: string; userTypeId: string },
): Promise<AppUser> {
  const type = await typeForUser(db, input.userTypeId);
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into app_user (username, password_hash, role, user_type_id)
       values ($1, $2, $3, $4)
       returning id::text`,
      [
        normalizeUsername(input.username),
        passwordHash,
        type.grantsAll ? "admin" : "editor",
        input.userTypeId,
      ],
    );
    return (await findUserById(db, rows[0]!.id))!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateUsernameError(normalizeUsername(input.username));
    }
    throw error;
  }
}

/** Moves a user to another type. Refuses to leave nobody able to manage users and types. */
export async function updateUserType(
  db: Queryable,
  id: string,
  userTypeId: string,
): Promise<AppUser | null> {
  const type = await typeForUser(db, userTypeId);
  const current = await findUserById(db, id);
  if (!current) return null;
  if (!type.isManager && current.isActive) {
    const remaining = await countActiveManagers(db, { excludingUserId: id });
    if (remaining === 0) throw new LastManagerGuardError("change this user's type");
  }
  await db.query(
    `update app_user set user_type_id = $1, role = $2, updated_at = now() where id = $3`,
    [userTypeId, type.grantsAll ? "admin" : "editor", id],
  );
  return findUserById(db, id);
}

export async function updateUserPassword(
  db: Queryable,
  id: string,
  password: string,
): Promise<AppUser | null> {
  const passwordHash = await hashPassword(password);
  await db.query(`update app_user set password_hash = $1, updated_at = now() where id = $2`, [
    passwordHash,
    id,
  ]);
  return findUserById(db, id);
}

export async function setUserActive(
  db: Queryable,
  id: string,
  isActive: boolean,
): Promise<AppUser | null> {
  if (!isActive && (await countActiveManagers(db, { excludingUserId: id })) === 0) {
    throw new LastManagerGuardError("deactivate this user");
  }
  await db.query(`update app_user set is_active = $1, updated_at = now() where id = $2`, [
    isActive,
    id,
  ]);
  return findUserById(db, id);
}

export async function deleteUser(db: Queryable, id: string): Promise<boolean> {
  if ((await countActiveManagers(db, { excludingUserId: id })) === 0) {
    throw new LastManagerGuardError("delete this user");
  }
  const result = await db.query<{ id: string }>(`delete from app_user where id = $1 returning id`, [
    id,
  ]);
  return result.rows.length === 1;
}

export async function touchLastLogin(db: Queryable, id: string): Promise<void> {
  await db.query(`update app_user set last_login_at = now() where id = $1`, [id]);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
