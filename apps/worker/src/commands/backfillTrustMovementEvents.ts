import { createPool } from "@railway/database";
import type { Config } from "../config.js";
import { createGarnerPool } from "../garner/garnerPool.js";
import { backfillCollapsedTrustMovements } from "../garner/bridge.js";

/** Six hours of TRUST movements is ~200k garner rows; the duplicate group-by stays light. */
const WINDOW_SECONDS = 6 * 3600;

/**
 * `backfill-trust-movement-events` — one-shot console command (run from the `worker` container
 * like `migrate`). Milestone 62: recovers the `trust_movement` rows the old idempotency key
 * dropped (an arrival and a departure at the same place in the same minute). Needs migration
 * 0041's flags-inclusive unique index in place first. Covers from the oldest movement RLM holds
 * to now unless `--since=<ISO>` is given. Idempotent, never deletes; safe alongside
 * `ingest-garner`.
 */
export async function runBackfillTrustMovementEvents(
  config: Config,
  argv: string[],
): Promise<void> {
  if (!config.GARNER_DB_HOST || !config.GARNER_DB_USER) {
    throw new Error("backfill-trust-movement-events requires GARNER_DB_HOST and GARNER_DB_USER");
  }
  const pg = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 120_000 });
  const garner = createGarnerPool(config);
  try {
    const sinceArg = argv.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
    let fromEpoch: number;
    if (sinceArg) {
      const parsed = Date.parse(sinceArg);
      if (Number.isNaN(parsed)) throw new Error(`--since is not a valid timestamp: ${sinceArg}`);
      fromEpoch = Math.floor(parsed / 1000);
    } else {
      const oldest = await pg.query<{ epoch: string | null }>(
        `select floor(extract(epoch from min(created)))::bigint::text as epoch from trust_movement`,
      );
      fromEpoch = Number(oldest.rows[0]?.epoch ?? Math.floor(Date.now() / 1000));
    }
    const toEpoch = Math.floor(Date.now() / 1000);
    const totals = await backfillCollapsedTrustMovements(
      garner,
      pg,
      fromEpoch,
      toEpoch,
      WINDOW_SECONDS,
      (window) => {
        if (window.inserted > 0) {
          console.log("backfill-trust-movement-events: window", {
            from: new Date(window.from * 1000).toISOString(),
            candidates: window.candidates,
            inserted: window.inserted,
          });
        }
      },
    );
    console.log("backfill-trust-movement-events: done", totals);
  } finally {
    await garner.end();
    await pg.end();
  }
}
