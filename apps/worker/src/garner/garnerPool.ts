import { createPool as createMysqlPool, type Pool as MysqlPool } from "mysql2/promise";
import type { Config } from "../config.js";

/**
 * Read-only connection pool to the operator's openrail-eps (`garner`) MariaDB — the source for
 * TRUST/VSTP-schedule/CORPUS/SMART data (ADR 0002). Only ever issues `SELECT`; the credentials
 * this connects with should be a `GRANT SELECT` user (openrail-eps' docker/README "External read
 * access"), never garner's admin `DB_USER`.
 */
export function createGarnerPool(config: Config): MysqlPool {
  return createMysqlPool({
    host: config.GARNER_DB_HOST,
    port: config.GARNER_DB_PORT,
    database: config.GARNER_DB_NAME,
    user: config.GARNER_DB_USER,
    password: config.GARNER_DB_PASSWORD,
    connectionLimit: 4,
    // garner stores every timestamp as an INT UNSIGNED epoch-seconds column, never a DATETIME —
    // so no date-string parsing concerns. Keep numbers as numbers.
    supportBigNumbers: true,
    bigNumberStrings: false,
    // Fail fast rather than hang the daemon tick if garner is unreachable.
    connectTimeout: 5000,
  });
}
