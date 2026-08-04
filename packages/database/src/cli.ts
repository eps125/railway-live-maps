#!/usr/bin/env node
import { createPool } from "./pool.js";
import { applyMigrations } from "./migrate.js";
import { resolveDefaultMigrationsDir } from "./migrationsDir.js";

const migrationsDir = resolveDefaultMigrationsDir();

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = createPool({ connectionString });
  try {
    const result = await applyMigrations(pool, migrationsDir);
    console.log(
      `Migrations applied: ${result.applied.length}, already applied: ${result.skipped.length}`,
    );
    if (result.applied.length > 0) {
      console.log(`Applied: ${result.applied.join(", ")}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
