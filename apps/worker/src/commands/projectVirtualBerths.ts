import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectVirtualBerths } from "../virtualBerths/projector.js";

/** `project-virtual-berths [--rebuild]` (docs/adr/0012) — the one-shot checkpoint/rebuild
 * command, same shape as `project-td [--rebuild]`. Processes whatever backlog is currently
 * available and exits; `project-virtual-berths-daemon` is the long-running equivalent. */
export async function runProjectVirtualBerthsCommand(
  config: Config,
  argv: string[],
): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runProjectVirtualBerths(pool, { rebuild });
    console.log(`project-virtual-berths complete${rebuild ? " (rebuild)" : ""}:`, summary);
  } finally {
    await pool.end();
  }
}
