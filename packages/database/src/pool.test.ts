import { describe, expect, it, vi } from "vitest";
import { createPool } from "./pool.js";

/**
 * The bug this guards against: with no `error` listener on a `pg.Pool`, an idle client whose
 * connection is dropped server-side (Postgres restart) makes Node throw an uncaught exception
 * and kill the process — this is how `project-td-daemon` died on `57P03` (2026-09-01).
 */
describe("createPool", () => {
  it("attaches an error listener so an idle-client error never becomes an uncaught exception", () => {
    const pool = createPool({ connectionString: "postgres://localhost/never-connected" });
    try {
      expect(pool.listenerCount("error")).toBeGreaterThan(0);

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      // Emitting 'error' with a listener present must NOT throw (without one, this throws).
      expect(() =>
        pool.emit("error", new Error("simulated idle client drop"), undefined),
      ).not.toThrow();
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    } finally {
      void pool.end();
    }
  });

  it("registers an onConnectSql handler when asked", () => {
    const pool = createPool({
      connectionString: "postgres://localhost/never-connected",
      onConnectSql: "set synchronous_commit = off",
    });
    try {
      expect(pool.listenerCount("connect")).toBeGreaterThan(0);
    } finally {
      void pool.end();
    }
  });
});
