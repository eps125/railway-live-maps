import { afterEach, describe, expect, it, vi } from "vitest";
import { ArrivalOrder } from "./arrivalOrder.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A step that records when it starts and finishes only when told to. */
function gatedStep(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return {
    run: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
    },
    finish: () => finish(),
  };
}

describe("ArrivalOrder", () => {
  it("runs ordered steps in ticket order however the frames' other work finishes", async () => {
    const order = new ArrivalOrder();
    const log: string[] = [];
    const first = order.ticket();
    const second = order.ticket();
    const a = gatedStep(log, "first");
    const b = gatedStep(log, "second");

    // The second frame's upload finished first, so it reaches its ordered step first.
    const secondDone = order.run(second, b.run);
    await Promise.resolve();
    expect(log).toEqual([]);

    const firstDone = order.run(first, a.run);
    await Promise.resolve();
    expect(log).toEqual(["start first"]);
    a.finish();
    await firstDone;
    await vi.waitFor(() => expect(log).toContain("start second"));
    b.finish();
    await secondDone;
    expect(log).toEqual(["start first", "end first", "start second", "end second"]);
    expect(order.timedOut).toBe(0);
  });

  it("doesn't hold later frames for a frame that is released without an ordered step", async () => {
    const order = new ArrivalOrder();
    const skipped = order.ticket(); // e.g. a heartbeat-only or failed frame
    const next = order.ticket();
    const ran = vi.fn(async () => {});
    const pending = order.run(next, ran);
    await Promise.resolve();
    expect(ran).not.toHaveBeenCalled();
    order.release(skipped);
    await pending;
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("lets a frame go ahead after maxWaitMs rather than wait on a stuck predecessor", async () => {
    vi.useFakeTimers();
    const order = new ArrivalOrder(5_000);
    order.ticket(); // never released: its storage is stuck retrying
    const next = order.ticket();
    const ran = vi.fn(async () => {});
    const pending = order.run(next, ran);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(order.timedOut).toBe(1);
  });

  it("after one timeout, later frames don't each wait for the same stuck frame", async () => {
    vi.useFakeTimers();
    const order = new ArrivalOrder(5_000);
    const stuck = order.ticket();
    const a = order.ticket();
    const b = order.ticket();
    const pendingA = order.run(a, async () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await pendingA;
    const ranB = vi.fn(async () => {});
    await order.run(b, ranB); // a has released, and stuck was given up on
    expect(ranB).toHaveBeenCalledTimes(1);
    expect(order.timedOut).toBe(1);
    order.release(stuck); // its late release changes nothing
    const c = order.ticket();
    const ranC = vi.fn(async () => {});
    await order.run(c, ranC);
    expect(ranC).toHaveBeenCalledTimes(1);
  });

  it("runs a retry straight away once the ticket is already released", async () => {
    const order = new ArrivalOrder();
    const t = order.ticket();
    await expect(
      order.run(t, async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");
    const later = order.ticket();
    await order.run(later, async () => {});
    // The retry of the first frame's ordered step must not wait for anything.
    const ran = vi.fn(async () => "ok");
    await expect(order.run(t, ran)).resolves.toBe("ok");
  });
});
