import { describe, expect, it, vi } from "vitest";
import { retryUntilDone } from "./retryUntilDone.js";

describe("retryUntilDone", () => {
  it("keeps retrying a transient failure until the operation succeeds", async () => {
    // The 2026-09-23 production failure modes: DNS and pg connect timeouts that cleared within
    // seconds but killed ingest-td because nothing retried them.
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN postgres"))
      .mockRejectedValueOnce(new Error("Connection terminated due to connection timeout"))
      .mockResolvedValueOnce("stored");
    const sleep = vi.fn(async () => {});
    const log = vi.fn();

    await expect(retryUntilDone(operation, { label: "TD frame record", sleep, log })).resolves.toBe(
      "stored",
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toMatch(/TD frame record failed \(attempt 1\)/);
  });

  it("backs off exponentially, capped at the configured maximum", async () => {
    const operation = vi.fn<() => Promise<void>>();
    for (let i = 0; i < 8; i++) operation.mockRejectedValueOnce(new Error("down"));
    operation.mockResolvedValueOnce(undefined);
    const delays: number[] = [];

    await retryUntilDone(operation, {
      label: "x",
      backoff: { baseMs: 100, maxMs: 1000, jitterRatio: 0 },
      sleep: async (ms) => {
        delays.push(ms);
      },
      log: () => {},
    });

    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 1000]);
  });

  it("rethrows instead of retrying once stopped", async () => {
    const failure = new Error("down");
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const sleep = vi.fn(async () => {});

    await expect(
      retryUntilDone(operation, { label: "x", isStopped: () => true, sleep, log: () => {} }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
