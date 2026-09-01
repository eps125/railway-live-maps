import { Pool, type PoolConfig } from "pg";

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  /** Extra `pg.Pool` options (application_name, a `connect`-time SET, …). Merged last, so it can
   * override the keepalive/timeout defaults below if a caller really needs to. */
  poolConfig?: Omit<PoolConfig, "connectionString" | "max">;
  /** SQL run once on every new physical connection (e.g. `set synchronous_commit = off` for a
   * pool that only writes rebuildable mirror data). Failures are logged, not fatal. */
  onConnectSql?: string;
  /** Server-side `statement_timeout` (ms) applied to every query on this pool. Set this on the
   * tight-loop daemons (`project-td-daemon`, `ingest-garner`) where no legitimate query is slow
   * and a hung query is catastrophic — a query issued on a connection Postgres silently killed
   * (e.g. during its own restart) otherwise waits *forever*, and `runDaemonLoop` never gets an
   * error to catch and retry. Leave unset for `migrate` / `--rebuild` / `prune-partitions`,
   * which legitimately run multi-minute statements. */
  statementTimeoutMs?: number;
}

/**
 * `pg.Pool` factory.
 *
 * - Attaches an `error` listener unconditionally: an idle pooled client whose TCP connection is
 *   dropped from the server side (a Postgres restart, a network blip, an admin
 *   `pg_terminate_backend`) emits `'error'` on the Pool, and with **no listener attached Node
 *   treats that as an uncaught exception and kills the process** — which is exactly how
 *   `project-td-daemon` died on a `57P03` when Postgres was restarted for tuning (2026-09-01).
 * - Enables TCP keepalive so a *checked-out* client on a half-open socket (the other failure mode
 *   from that same restart — the query just hangs, no error ever arrives) is detected in minutes
 *   rather than never.
 * - `statementTimeoutMs` (opt-in) is the belt to that braces: a hard server-side cap so a hung
 *   query fails fast and the daemon's next tick reconnects.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Don't wait forever to acquire a connection either (default is no timeout).
    connectionTimeoutMillis: 10_000,
    ...(options.statementTimeoutMs !== undefined
      ? { statement_timeout: options.statementTimeoutMs, query_timeout: options.statementTimeoutMs }
      : {}),
    ...options.poolConfig,
  });

  pool.on("error", (error) => {
    console.error(
      "pg pool: idle client error — the client has been removed; the next query reconnects",
      error,
    );
  });

  if (options.onConnectSql) {
    const sql = options.onConnectSql;
    pool.on("connect", (client) => {
      client.query(sql).catch((error: unknown) => {
        console.error(`pg pool: onConnectSql (${sql}) failed`, error);
      });
    });
  }

  return pool;
}

export async function checkConnectivity(pool: Pool): Promise<void> {
  const result = await pool.query("select 1 as ok");
  if (result.rows[0]?.ok !== 1) {
    throw new Error("Postgres connectivity check returned an unexpected result");
  }
}
