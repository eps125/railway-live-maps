import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export interface MigrationFile {
  name: string;
  path: string;
}

/** Lists `.sql` files in a migrations directory, sorted lexically (filenames must be zero-padded, e.g. `0001_x.sql`). */
export async function listMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: join(migrationsDir, name) }));
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      id bigserial primary key,
      name text not null unique,
      applied_at timestamptz not null default now()
    )
  `);
}

async function appliedMigrationNames(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>("select name from schema_migrations");
  return new Set(result.rows.map((row) => row.name));
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
}

/** Applies every not-yet-recorded `.sql` file in `migrationsDir`, in order, each in its own transaction. */
export async function applyMigrations(
  pool: Pool,
  migrationsDir: string,
): Promise<ApplyMigrationsResult> {
  await ensureMigrationsTable(pool);
  const files = await listMigrationFiles(migrationsDir);
  const already = await appliedMigrationNames(pool);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (already.has(file.name)) {
      skipped.push(file.name);
      continue;
    }

    const sql = await readFile(file.path, "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file.name]);
      await client.query("commit");
      applied.push(file.name);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
