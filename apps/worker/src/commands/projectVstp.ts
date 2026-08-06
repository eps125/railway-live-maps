import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectVstp } from "../vstp/projector.js";

/** `project-vstp [--rebuild]` — the VSTP projector checkpoint/rebuild command
 * (docs/IMPLEMENTATION_PLAN.md Milestone 7), mirroring `project-td`. One-shot: processes
 * whatever backlog is currently available and exits. */
export async function runProjectVstpCommand(config: Config, argv: string[]): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runProjectVstp(pool, { rebuild });
    console.log(`project-vstp complete${rebuild ? " (rebuild)" : ""}:`, summary);
  } finally {
    await pool.end();
  }
}
