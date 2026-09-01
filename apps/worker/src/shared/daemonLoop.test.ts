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
