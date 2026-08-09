import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectResolver } from "../resolver/projector.js";

/** `project-resolver [--rebuild]` — the berth-to-run resolver projector command
 * (docs/IMPLEMENTATION_PLAN.md Milestone 9). One-shot: processes whatever backlog/retry
 * candidates are currently available and exits, mirroring project-td/project-vstp/project-trust. */
export async function runProjectResolverCommand(config: Config, argv: string[]): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runProjectResolver(pool, { rebuild });
    console.log(`project-resolver complete${rebuild ? " (rebuild)" : ""}:`, summary);
  } finally {
    await pool.end();
  }
}
