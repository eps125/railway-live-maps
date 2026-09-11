import { describe, expect, it, vi, afterEach } from "vitest";
import { runUntilShutdownSignal } from "./runUntilShutdownSignal.js";

describe("runUntilShutdownSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls stop() and exits when SIGTERM arrives", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stop = vi.fn().mockResolvedValue(undefined);

    void runUntilShutdownSignal(stop);
    process.emit("SIGTERM");
    // Let the async shutdown handler's microtasks run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it(
    "2026-09-11 TD reconnect-instability root cause: a caller that awaits a never-resolving " +
      "connection.start() before calling this never actually registers a SIGTERM handler",
    async () => {
      // apps/worker/src/commands/ingestTd.ts used to do `await connection.start(...)` before
      // `return runUntilShutdownSignal(...)`. StompConnection.start() (stomp/stompConnection.ts)
      // runs `while (!this.stopped) { ... }` and only resolves once `stop()` sets `stopped = true`
      // — i.e. never, during ordinary healthy operation. So the `await` above never completes,
      // `runUntilShutdownSignal` (and the SIGTERM/SIGINT listeners it registers) is never reached,
      // and every ordinary container stop/restart/redeploy sends SIGTERM to a process with no
      // handler for it — Node's default disposition terminates it immediately, skipping
      // connection.stop() entirely (no STOMP DISCONNECT sent, and `feed_connection_session
      // .disconnected_at` never gets written, both confirmed against production data). This test
      // reproduces exactly that shape with a fake "never resolves until stopped" promise standing
      // in for StompConnection.start(), proving the buggy call order silently drops SIGTERM.
      const stop = vi.fn().mockResolvedValue(undefined);
      // Deliberately never resolved — mirrors StompConnection.start()'s real behavior (its
      // `while (!this.stopped)` loop only resolves after `stop()` sets `stopped = true`, which
      // never happens here since nothing calls it). Left permanently pending is fine for this
      // test; nothing awaits it after the assertions below.
      const neverResolvingStart = new Promise<void>(() => {});

      const buggyOrder = async (): Promise<void> => {
        await neverResolvingStart; // mirrors `await connection.start(...)`
        await runUntilShutdownSignal(stop);
      };
      void buggyOrder();

      process.emit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));

      // The bug: stop() is never called, because runUntilShutdownSignal was never reached.
      expect(stop).not.toHaveBeenCalled();
    },
  );

  it("the fix: NOT awaiting the connection's start() first lets SIGTERM be handled immediately, even while it's still pending", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stop = vi.fn().mockResolvedValue(undefined);
    const neverResolvingStart = new Promise<void>(() => {});

    const fixedOrder = (): Promise<never> => {
      void neverResolvingStart; // fire-and-forget, matching the fix in ingestTd.ts
      return runUntilShutdownSignal(stop);
    };
    void fixedOrder();

    process.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
