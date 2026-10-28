import { createPool } from "@railway/database";
import {
  createUser,
  deleteUser,
  DuplicateUsernameError,
  findUserByUsername,
  findUserTypeByName,
  InvalidUserTypeError,
  LastManagerGuardError,
  listUsers,
  setUserActive,
  updateUserPassword,
  updateUserType,
  type AppUser,
} from "@railway/database";
import type { Config } from "../config.js";

/**
 * `manage-users <action> [flags]` — the operator-facing CLI for Milestone 29's multi-user,
 * role-based login. Owner explicitly rejected an `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` env-var
 * single-credential design in favour of a real `app_user` table (migration `0029_app_user.sql`),
 * which means there is no bootstrap row anywhere — the very first admin account has to come from
 * somewhere outside the (auth-gated) API itself. This command is that "somewhere," run once by
 * hand against the deployed worker container (`docker exec ... node dist/index.js manage-users
 * create --username ... --type Admin`), matching this repo's existing pattern of one-shot
 * operational CLI commands (`publish-map`, `prune-partitions`) rather than a magic seed row or a
 * plaintext credential anywhere in Git. Once at least one admin exists, day-to-day user management
 * goes through the web UI (`/api/v1/admin/users`) instead.
 *
 * A password is accepted via `--password <value>` or the `MANAGE_USERS_PASSWORD` env var (the
 * latter lets an operator avoid a plaintext password ending up in their shell history) — never
 * both silently preferring one without saying so.
 *
 * Milestone 99 (docs/adr/0022): users have a user type, named with `--type "<name>"` (e.g.
 * `--type Admin`, `--type "Enhanced Editor"`); `--role admin|editor` is still accepted as
 * shorthand for the Admin / Enhanced Editor types.
 */
function findFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function resolvePassword(argv: string[]): string | { error: string } {
  const fromFlag = findFlag(argv, "password");
  const fromEnv = process.env["MANAGE_USERS_PASSWORD"];
  const password = fromFlag ?? fromEnv;
  if (!password) {
    return {
      error:
        "manage-users: a password is required, via --password <value> or the " +
        "MANAGE_USERS_PASSWORD env var",
    };
  }
  if (password.length < 8) {
    return { error: "manage-users: password must be at least 8 characters" };
  }
  return password;
}

/** `--type <name>`, or the old `--role admin|editor` (Admin / Enhanced Editor). */
async function resolveUserType(
  pool: ReturnType<typeof createPool>,
  argv: string[],
): Promise<string | { error: string }> {
  const role = findFlag(argv, "role");
  const name =
    findFlag(argv, "type") ??
    (role === "admin" ? "Admin" : role === "editor" ? "Enhanced Editor" : undefined);
  if (!name) return { error: 'manage-users: --type "<user type name>" is required' };
  const type = await findUserTypeByName(pool, name);
  if (!type || type.systemKey === "public") {
    return { error: `manage-users: no user type named "${name}" can be given to a user` };
  }
  return type.id;
}

function printUser(user: AppUser): void {
  console.log(
    `  ${user.id}\t${user.username}\t${user.userTypeName}\t${user.isActive ? "active" : "inactive"}\t` +
      `created ${user.createdAt.toISOString()}\t` +
      `last login ${user.lastLoginAt ? user.lastLoginAt.toISOString() : "never"}`,
  );
}

export async function runManageUsers(config: Config, argv: string[]): Promise<void> {
  const action = argv[0];
  const rest = argv.slice(1);
  const pool = createPool({ connectionString: config.DATABASE_URL });

  try {
    switch (action) {
      case "create": {
        const username = findFlag(rest, "username");
        if (!username) {
          console.error("manage-users create: --username <name> is required");
          process.exitCode = 1;
          return;
        }
        const password = resolvePassword(rest);
        if (typeof password !== "string") {
          console.error(password.error);
          process.exitCode = 1;
          return;
        }
        const userTypeId = await resolveUserType(pool, rest);
        if (typeof userTypeId !== "string") {
          console.error(userTypeId.error);
          process.exitCode = 1;
          return;
        }
        try {
          const user = await createUser(pool, { username, password, userTypeId });
          console.log(`manage-users: created "${user.username}" (${user.userTypeName})`);
        } catch (error) {
          if (error instanceof DuplicateUsernameError) {
            console.error(`manage-users create: ${error.message}`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }
        return;
      }

      case "list": {
        const users = await listUsers(pool);
        if (users.length === 0) {
          console.log("manage-users: no users exist yet — create the first admin with `create`");
          return;
        }
        console.log("  id\tusername\tuser type\tstatus\tcreated\tlast login");
        for (const user of users) printUser(user);
        return;
      }

      case "set-type":
      case "set-role": {
        const username = findFlag(rest, "username");
        if (!username) {
          console.error(`manage-users ${action}: --username <name> is required`);
          process.exitCode = 1;
          return;
        }
        const userTypeId = await resolveUserType(pool, rest);
        if (typeof userTypeId !== "string") {
          console.error(userTypeId.error);
          process.exitCode = 1;
          return;
        }
        await withUserByUsername(pool, username, (user) =>
          updateUserType(pool, user.id, userTypeId),
        );
        return;
      }

      case "set-password": {
        const username = findFlag(rest, "username");
        if (!username) {
          console.error("manage-users set-password: --username <name> is required");
          process.exitCode = 1;
          return;
        }
        const password = resolvePassword(rest);
        if (typeof password !== "string") {
          console.error(password.error);
          process.exitCode = 1;
          return;
        }
        await withUserByUsername(pool, username, (user) =>
          updateUserPassword(pool, user.id, password),
        );
        return;
      }

      case "set-active": {
        const username = findFlag(rest, "username");
        const activeFlag = findFlag(rest, "active");
        if (!username || (activeFlag !== "true" && activeFlag !== "false")) {
          console.error(
            "manage-users set-active: --username <name> and --active <true|false> are required",
          );
          process.exitCode = 1;
          return;
        }
        await withUserByUsername(pool, username, (user) =>
          setUserActive(pool, user.id, activeFlag === "true"),
        );
        return;
      }

      case "delete": {
        const username = findFlag(rest, "username");
        if (!username) {
          console.error("manage-users delete: --username <name> is required");
          process.exitCode = 1;
          return;
        }
        await withUserByUsername(pool, username, async (user) => {
          const deleted = await deleteUser(pool, user.id);
          return deleted ? user : null;
        });
        return;
      }

      default:
        console.error(
          `manage-users: unknown action "${action ?? ""}". Expected one of: create, list, ` +
            "set-type, set-password, set-active, delete",
        );
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

async function withUserByUsername(
  pool: ReturnType<typeof createPool>,
  username: string,
  action: (user: AppUser) => Promise<AppUser | null>,
): Promise<void> {
  const user = await findUserByUsername(pool, username);
  if (!user) {
    console.error(`manage-users: no user named "${username}"`);
    process.exitCode = 1;
    return;
  }
  try {
    const updated = await action(user);
    if (!updated) {
      console.error(`manage-users: no user named "${username}"`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `manage-users: updated "${updated.username}" (${updated.userTypeName}, ${updated.isActive ? "active" : "inactive"})`,
    );
  } catch (error) {
    if (error instanceof LastManagerGuardError || error instanceof InvalidUserTypeError) {
      console.error(`manage-users: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
