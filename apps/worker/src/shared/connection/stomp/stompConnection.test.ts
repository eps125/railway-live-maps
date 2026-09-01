import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame } from "./frame.js";

/** `stop()` now waits (via a real timer) for the broker to process a DISCONNECT frame before
 * closing the socket — under `vi.useFakeTimers()` that wait never resolves on its own, so every
 * call site in this file needs to advance timers alongside it rather than just `await`ing it. */
async function stopAndAdvance(connection: { stop: () => Promise<void> }): Promise<void> {
  const stopping = connection.stop();
  await vi.advanceTimersByTimeAsync(500);
  await stopping;
}

/**
 * Regression coverage for a real production incident: `connectOnce` previously had no
 * timeout at all, so a connection attempt that was silently dropped (a firewall blackholing
 * the port rather than actively refusing it — exactly what happened when this feed's egress
 * network was misconfigured) hung the returned promise forever with nothing ever logged,
 * indistinguishable from a slow-but-working connection.
 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  write = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
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

vi.mock("node:net", () => ({ connect: connectMock }));

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

    await stopAndAdvance(connection);
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

    await stopAndAdvance(connection);
  });
});

describe("StompConnection heartbeat", () => {
  it("sends periodic heartbeat frames once connected, even with no incoming messages", async () => {
    // Regression test: the CONNECT frame advertises a heart-beat interval, but nothing
    // actually sent one — ACK frames happened to mask this on busy feeds (TD), but a quiet
    // feed (VSTP; TRUST/TD overnight) can go longer than the promised interval between ACKs,
    // and Network Rail's broker then closes the connection thinking the client vanished
    // (AMQ229014: "Did not receive data ... within the connection TTL").
    vi.useFakeTimers();
    const connection = new StompConnection({
      feedName: "VSTP",
      host: "example.invalid",
      port: 1,
      topic: "/topic/x",
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
      heartbeatMs: 1000, // -> heartbeat send interval of max(1000, floor(1000*0.8)) = 1000ms
    });
    const options = baseOptions();
    void connection.start(options);

    await vi.advanceTimersByTimeAsync(0);
    const socket = getLastSocket()!;
    socket.emit(
      "data",
      encodeFrame({ command: "CONNECTED", headers: { session: "sess-1" }, body: Buffer.alloc(0) }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const writesBeforeHeartbeats = socket.write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000); // three heartbeat intervals

    const heartbeatWrites = socket.write.mock.calls
      .slice(writesBeforeHeartbeats)
      .filter(([chunk]) => Buffer.isBuffer(chunk) && chunk.toString("utf8") === "\n");
    expect(heartbeatWrites).toHaveLength(3);

    await stopAndAdvance(connection);
  });

  it("stops sending heartbeats once the connection closes", async () => {
    vi.useFakeTimers();
    const connection = new StompConnection({
      feedName: "VSTP",
      host: "example.invalid",
      port: 1,
      topic: "/topic/x",
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
      heartbeatMs: 1000,
    });
    const options = baseOptions();
    void connection.start(options);

    await vi.advanceTimersByTimeAsync(0);
    const socket = getLastSocket()!;
    socket.emit(
      "data",
      encodeFrame({ command: "CONNECTED", headers: { session: "sess-1" }, body: Buffer.alloc(0) }),
    );
    await vi.advanceTimersByTimeAsync(0);

    socket.emit("close");
    await vi.advanceTimersByTimeAsync(0);

    const writesAfterClose = socket.write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.write.mock.calls.length).toBe(writesAfterClose);

    await stopAndAdvance(connection);
  });
});

describe("StompConnection stale-feed watchdog", () => {
  it("force-closes the socket when nothing arrives from the broker for staleTimeoutMs", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const connection = new StompConnection({
      feedName: "TD",
      host: "example.invalid",
      port: 1,
      topic: "/topic/x",
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
      staleTimeoutMs: 9000,
    });
    const options = baseOptions();
    void connection.start(options);

    await vi.advanceTimersByTimeAsync(0);
    const socket = getLastSocket()!;
    socket.emit(
      "data",
      encodeFrame({ command: "CONNECTED", headers: { session: "sess-1" }, body: Buffer.alloc(0) }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Total silence from the broker (no MESSAGE, no heartbeat LF) well past the stale window
    // (watchdog polls every ~staleTimeoutMs/3, so give it two poll cycles past the threshold).
    await vi.advanceTimersByTimeAsync(15_000);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/feed stalled/i));

    socket.emit("close");
    consoleError.mockRestore();
    await stopAndAdvance(connection);
  });

  it("keeps a connection alive as long as any data (even a heartbeat) keeps arriving", async () => {
    vi.useFakeTimers();
    const connection = new StompConnection({
      feedName: "TD",
      host: "example.invalid",
      port: 1,
      topic: "/topic/x",
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
      staleTimeoutMs: 9000,
    });
    const options = baseOptions();
    void connection.start(options);

    await vi.advanceTimersByTimeAsync(0);
    const socket = getLastSocket()!;
    socket.emit(
      "data",
      encodeFrame({ command: "CONNECTED", headers: { session: "sess-1" }, body: Buffer.alloc(0) }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // A bare-LF heartbeat every 4s for 20s — well past staleTimeoutMs in aggregate, but never
    // 9s of continuous silence.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      socket.emit("data", Buffer.from("\n"));
    }

    expect(socket.destroy).not.toHaveBeenCalled();

    await stopAndAdvance(connection);
  });
});

describe("StompConnection stop", () => {
  it("sends a STOMP DISCONNECT frame and waits before closing the socket", async () => {
    // Regression test for a real production incident: closing the raw TCP socket without ever
    // sending DISCONNECT left Network Rail's broker treating the session as still alive for far
    // longer than this client's own reconnect backoff, so every reconnect attempt (even with a
    // brand new client-id) was rejected with "AMQ339009: Exception getting session" until the
    // stale session eventually expired broker-side.
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

    await vi.advanceTimersByTimeAsync(0);
    const socket = getLastSocket()!;
    socket.emit(
      "data",
      encodeFrame({ command: "CONNECTED", headers: { session: "sess-1" }, body: Buffer.alloc(0) }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const stopping = connection.stop();
    const disconnectSent = socket.write.mock.calls.some(
      ([chunk]) => Buffer.isBuffer(chunk) && chunk.toString("utf8").startsWith("DISCONNECT\n"),
    );
    expect(disconnectSent).toBe(true);
    // The socket must not be closed immediately — the broker needs a moment to process DISCONNECT.
    expect(socket.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect(socket.end).toHaveBeenCalledTimes(1);
  });
});
