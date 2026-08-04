import { Pool } from "pg";

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
}

export function createPool(options: CreatePoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
  });
}

export async function checkConnectivity(pool: Pool): Promise<void> {
  const result = await pool.query("select 1 as ok");
  if (result.rows[0]?.ok !== 1) {
    throw new Error("Postgres connectivity check returned an unexpected result");
  }
}
