import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectTd } from "../td/projector.js";

/** `project-td [--rebuild]` — the projector checkpoint/rebuild command
 * (docs/IMPLEMENTATION_PLAN.md Milestone 4). One-shot: processes whatever backlog is currently
 * available and exits, mirroring replay-fixtures/migrate. */
export async function runProjectTdCommand(config: Config, argv: string[]): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runProjectTd(pool, { rebuild });
    console.log(`project-td complete${rebuild ? " (rebuild)" : ""}:`, summary);
  } finally {
    await pool.end();
  }
}
