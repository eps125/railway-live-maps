import { createPool, applyMigrations, resolveDefaultMigrationsDir } from "@railway/database";
import type { Config } from "../config.js";
import { ensureAllPartitions } from "./ensurePartitions.js";

export async function runMigrate(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const result = await applyMigrations(pool, resolveDefaultMigrationsDir());
    console.log(
      `Migrations applied: ${result.applied.length}, already applied: ${result.skipped.length}`,
    );
    if (result.applied.length > 0) {
      console.log(`Applied: ${result.applied.join(", ")}`);
    }

    await ensureAllPartitions(pool, config);
  } finally {
    await pool.end();
  }
}
