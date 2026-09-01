import { Pool, type PoolConfig } from "pg";

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  /** Extra `pg.Pool` options (statement_timeout, application_name, a `connect`-time SET, …). */
  poolConfig?: Omit<PoolConfig, "connectionString" | "max">;
  /** SQL run once on every new physical connection (e.g. `set synchronous_commit = off` for a
   * pool that only writes rebuildable mirror data). Failures are logged, not fatal. */
  onConnectSql?: string;
}

/**
 * `pg.Pool` factory. Attaches an `error` listener unconditionally: an idle pooled client whose
 * TCP connection is dropped from the server side (a Postgres restart, a network blip, an admin
 * `pg_terminate_backend`) emits `'error'` on the Pool, and with **no listener attached Node
 * treats that as an uncaught exception and kills the process** — which is exactly how
 * `project-td-daemon` died on a `57P03` when Postgres was restarted for tuning (2026-09-01).
 * With a listener, the Pool just discards that client and the next `query()` establishes a fresh
 * connection, so a daemon on `runDaemonLoop` self-heals on its next tick.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
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
