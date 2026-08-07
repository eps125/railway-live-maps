import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame } from "./frame.js";

/**
 * Regression coverage for a real production incident: `connectOnce` previously had no
 * timeout at all, so a connection attempt that was silently dropped (a firewall blackholing
 * the port rather than actively refusing it — exactly what happened when this feed's egress
 * network was misconfigured) hung the returned promise forever with nothing ever logged,
 * indistinguishable from a slow-but-working connection.
 */
class FakeSocket extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn();
  end = vi.fn();
}

// `vi.mock` factories are hoisted above regular imports, so anything they reference must be
// created via `vi.hoisted` rather than an ordinary top-level `const`.
const { connectMock, getLastSocket } = vi.hoisted(() => {
  let lastSocket: FakeSocket | null = null;
  const connectMock = vi.fn((_options: unknown, onConnect?: () => void) => {
    const socket = new FakeSocket();
    lastSocket = socket;
    if (onConnect) queueMicrotask(onConnect);
    return socket;
  });
  return { connectMock, getLastSocket: () => lastSocket };
});

vi.mock("node:tls", () => ({ connect: connectMock }));

const { StompConnection } = await import("./stompConnection.js");

function baseOptions() {
  return {
    onFrame: vi.fn(async () => {}),
    onSessionStart: vi.fn(async () => "session-1"),
    onSessionEnd: vi.fn(async () => {}),
    onError: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("StompConnection connect timeout", () => {
  it("reports an error instead of hanging forever when the broker never responds", async () => {
    vi.useFakeTimers();
    const connection = new StompConnection({
      feedName: "TD",
      host: "example.invalid",
      port: 1,
      topic: "/topic/x",
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
    });
    const options = baseOptions();
    void connection.start(options);

    await vi.advanceTimersByTimeAsync(5000);

    expect(options.onError).toHaveBeenCalledTimes(1);
    const error = options.onError.mock.calls[0]?.[0] as Error;
    expect(error.message).toMatch(/timed out/i);
    expect(getLastSocket()?.destroy).toHaveBeenCalled();

    await connection.stop();
  });

  it("does not kill a connection that receives CONNECTED before the timeout elapses", async () => {
    vi.useFakeTimers();
    const connection = new StompConnection({
      feedName: "TD",
      host: "example.invalid",
      port: 1,
      topic: "/topic/x",
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
    });
    const options = baseOptions();
    void connection.start(options);

    await vi.advanceTimersByTimeAsync(0); // let the connect callback's queued microtask run
    getLastSocket()!.emit(
      "data",
      encodeFrame({ command: "CONNECTED", headers: { session: "sess-1" }, body: Buffer.alloc(0) }),
    );
    await vi.advanceTimersByTimeAsync(0); // flush the async CONNECTED handler

    // Well past connectTimeoutMs — a healthy connection must not be killed just for staying open.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(options.onSessionStart).toHaveBeenCalledTimes(1);
    expect(options.onError).not.toHaveBeenCalled();
    expect(getLastSocket()?.destroy).not.toHaveBeenCalled();

    await connection.stop();
  });
});
