import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectTrust } from "../trust/projector.js";

/** `project-trust [--rebuild]` — the TRUST projector checkpoint/rebuild command
 * (docs/IMPLEMENTATION_PLAN.md Milestone 8), mirroring `project-td`/`project-vstp`. One-shot:
 * processes whatever backlog is currently available and exits. */
export async function runProjectTrustCommand(config: Config, argv: string[]): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runProjectTrust(pool, { rebuild });
    console.log(`project-trust complete${rebuild ? " (rebuild)" : ""}:`, summary);
  } finally {
    await pool.end();
  }
}
