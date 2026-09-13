import bcrypt from "bcryptjs";
import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 29 (docs/IMPLEMENTATION_PLAN.md): shared user CRUD + password hashing, used by both
 * `apps/api` (login) and `apps/worker` (the `manage-users` bootstrap/admin CLI) — see
 * `migrations/0029_app_user.sql` for why this lives here rather than as a second copy in each app.
 */

export const USER_ROLES = ["admin", "editor"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Higher rank can do everything a lower rank can. Only two levels exist today; add a new entry
 * here (and to `USER_ROLES` + the `app_user_role_check` migration) if a third is ever needed. */
export const USER_ROLE_RANK: Record<UserRole, number> = {
  editor: 1,
  admin: 2,
};

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

export function roleSatisfies(role: UserRole, minRole: UserRole): boolean {
  return USER_ROLE_RANK[role] >= USER_ROLE_RANK[minRole];
}

export interface AppUser {
  id: string;
  username: string;
  role: UserRole;
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
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

function toAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role as UserRole,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

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
  const { rows } = await db.query<AppUserRow>(`select * from app_user where username = $1`, [
    normalizeUsername(username),
  ]);
  const row = rows[0];
  return row ? { ...toAppUser(row), passwordHash: row.password_hash } : null;
}

export async function findUserById(db: Queryable, id: string): Promise<AppUser | null> {
  const { rows } = await db.query<AppUserRow>(`select * from app_user where id = $1`, [id]);
  const row = rows[0];
  return row ? toAppUser(row) : null;
}

export async function listUsers(db: Queryable): Promise<AppUser[]> {
  const { rows } = await db.query<AppUserRow>(`select * from app_user order by created_at asc`);
  return rows.map(toAppUser);
}

/** Counts active admins other than `excludingUserId` (pass `null` when creating/checking with no
 * user to exclude) — the basis for the "never remove the last admin" guard below. */
export async function countOtherActiveAdmins(
  db: Queryable,
  excludingUserId: string | null,
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `select count(*)::text as count
     from app_user
     where role = 'admin' and is_active = true
       and ($1::bigint is null or id != $1::bigint)`,
    [excludingUserId],
  );
  return Number(rows[0]?.count ?? "0");
}

/** Thrown when an action would leave the system with no active admin at all — self-hosted,
 * single-owner app with no "contact support to unlock your account" path, so this is a real
 * lockout risk worth refusing outright rather than a soft warning. */
export class LastAdminGuardError extends Error {
  constructor(action: string) {
    super(`Refusing to ${action}: this is the last active admin account`);
    this.name = "LastAdminGuardError";
  }
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`A user named "${username}" already exists`);
    this.name = "DuplicateUsernameError";
  }
}

export async function createUser(
  db: Queryable,
  input: { username: string; password: string; role: UserRole },
): Promise<AppUser> {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await db.query<AppUserRow>(
      `insert into app_user (username, password_hash, role)
       values ($1, $2, $3)
       returning *`,
      [normalizeUsername(input.username), passwordHash, input.role],
    );
    return toAppUser(rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateUsernameError(normalizeUsername(input.username));
    }
    throw error;
  }
}

export async function updateUserRole(
  db: Queryable,
  id: string,
  role: UserRole,
): Promise<AppUser | null> {
  if (role !== "admin") {
    const current = await findUserById(db, id);
    if (current?.role === "admin" && current.isActive) {
      const remaining = await countOtherActiveAdmins(db, id);
      if (remaining === 0) {
        throw new LastAdminGuardError("change this user's role away from admin");
      }
    }
  }
  const { rows } = await db.query<AppUserRow>(
    `update app_user set role = $1, updated_at = now() where id = $2 returning *`,
    [role, id],
  );
  return rows[0] ? toAppUser(rows[0]) : null;
}

export async function updateUserPassword(
  db: Queryable,
  id: string,
  password: string,
): Promise<AppUser | null> {
  const passwordHash = await hashPassword(password);
  const { rows } = await db.query<AppUserRow>(
    `update app_user set password_hash = $1, updated_at = now() where id = $2 returning *`,
    [passwordHash, id],
  );
  return rows[0] ? toAppUser(rows[0]) : null;
}

export async function setUserActive(
  db: Queryable,
  id: string,
  isActive: boolean,
): Promise<AppUser | null> {
  if (!isActive) {
    const current = await findUserById(db, id);
    if (current?.role === "admin") {
      const remaining = await countOtherActiveAdmins(db, id);
      if (remaining === 0) {
        throw new LastAdminGuardError("deactivate this user");
      }
    }
  }
  const { rows } = await db.query<AppUserRow>(
    `update app_user set is_active = $1, updated_at = now() where id = $2 returning *`,
    [isActive, id],
  );
  return rows[0] ? toAppUser(rows[0]) : null;
}

export async function deleteUser(db: Queryable, id: string): Promise<boolean> {
  const current = await findUserById(db, id);
  if (current?.role === "admin" && current.isActive) {
    const remaining = await countOtherActiveAdmins(db, id);
    if (remaining === 0) {
      throw new LastAdminGuardError("delete this user");
    }
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
