import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { runProjectResolver } from "../resolver/projector.js";

/**
 * `project-resolver [--rebuild] [--backfill --since <date>]` — the berth-to-run resolver
 * projector command (docs/IMPLEMENTATION_PLAN.md Milestone 9). One-shot: processes whatever
 * backlog/retry candidates are currently available and exits, mirroring
 * project-td/project-vstp/project-trust.
 *
 * Normal (no flags): the live loop — checkpointed forward scan + retry pass, both bounded to
 * occupancies entered within `RESOLVER_LIVE_WINDOW_HOURS`.
 * `--rebuild`: clear every resolution row and reprocess the entire retained history (ignores the
 * live window — the rare, deliberate escape hatch).
 * `--backfill --since <ISO date>`: resolve occupancies with `entered_at >= <date>` that aren't
 * already at the current resolver version, without touching the live checkpoint. Runs under its
 * own advisory lock so it can catch history up alongside the 1s live loop rather than fighting it
 * for the lock. Bounded per invocation — re-run until the summary's `moreBacklogRemains` is false.
 */
export async function runProjectResolverCommand(config: Config, argv: string[]): Promise<void> {
  const rebuild = argv.includes("--rebuild");
  const backfill = argv.includes("--backfill");
  const sinceIndex = argv.indexOf("--since");
  const sinceRaw = sinceIndex >= 0 ? argv[sinceIndex + 1] : undefined;

  if (rebuild && backfill) {
    throw new Error("project-resolver: --rebuild and --backfill are mutually exclusive");
  }
  let backfillSince: Date | undefined;
  if (backfill) {
    if (!sinceRaw) {
      throw new Error(
        "project-resolver --backfill requires --since <ISO date>, e.g. --since 2026-08-13",
      );
    }
    backfillSince = new Date(sinceRaw);
    if (Number.isNaN(backfillSince.getTime())) {
      throw new Error(`project-resolver --since: not a valid date: ${sinceRaw}`);
    }
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const summary = await runProjectResolver(pool, {
      rebuild,
      liveWindowMs: config.RESOLVER_LIVE_WINDOW_HOURS * 60 * 60 * 1000,
      ...(backfillSince ? { backfillSince } : {}),
    });
    const mode = backfill ? " (backfill)" : rebuild ? " (rebuild)" : "";
    console.log(`project-resolver complete${mode}:`, summary);
  } finally {
    await pool.end();
  }
}
