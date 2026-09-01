import { afterEach, describe, expect, it, vi } from "vitest";
import { runDaemonLoop } from "./daemonLoop.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runDaemonLoop", () => {
  it("ticks repeatedly until SIGTERM, then runs onShutdown and resolves", async () => {
    let ticks = 0;
    let shutdownRan = false;

    const loop = runDaemonLoop({
      label: "test",
      intervalMs: 5,
      tick: async () => {
        ticks += 1;
        if (ticks === 3) process.emit("SIGTERM");
      },
      onShutdown: async () => {
        shutdownRan = true;
      },
    });

    await loop;
    expect(ticks).toBe(3);
    expect(shutdownRan).toBe(true);
  });

  it("logs and continues when a tick throws rather than crashing the loop", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let ticks = 0;

    await runDaemonLoop({
      label: "test",
      intervalMs: 1,
      errorBackoffMs: 1, // keep the test fast — the real default is 5s
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error("boom");
        if (ticks === 2) process.emit("SIGTERM");
      },
    });

    expect(ticks).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith("test: tick failed", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("waits errorBackoffMs (not intervalMs) after a failing tick before retrying", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tickAt: number[] = [];

    const loop = runDaemonLoop({
      label: "test",
      intervalMs: 10,
      errorBackoffMs: 2000,
      tick: async () => {
        tickAt.push(Date.now());
        if (tickAt.length === 1) throw new Error("boom");
        process.emit("SIGTERM");
      },
    });

    await vi.advanceTimersByTimeAsync(50); // past intervalMs, well short of errorBackoffMs
    expect(tickAt).toHaveLength(1); // still backing off — not retried after only 10ms

    await vi.advanceTimersByTimeAsync(2000);
    await loop;
    expect(tickAt).toHaveLength(2);
    expect(tickAt[1]! - tickAt[0]!).toBeGreaterThanOrEqual(2000);

    errorSpy.mockRestore();
  });

  it("still runs onShutdown if a tick throws on the final iteration", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let shutdownRan = false;

    await runDaemonLoop({
      label: "test",
      intervalMs: 1,
      tick: async () => {
        process.emit("SIGTERM");
        throw new Error("boom on the way out");
      },
      onShutdown: async () => {
        shutdownRan = true;
      },
    });

    expect(shutdownRan).toBe(true);
    errorSpy.mockRestore();
  });
});
