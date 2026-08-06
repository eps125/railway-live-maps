import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveMapSocket } from "./useLiveMapSocket.js";

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  close(): void {
    this.emit("close", {});
  }

  emit(type: string, event: { data?: string } = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }

  sendFromServer(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

const snapshot = {
  type: "snapshot" as const,
  protocolVersion: 1 as const,
  sequence: 10,
  state: {
    mode: "live" as const,
    quality: { status: "ok" as const, gaps: [] },
    berths: {
      "berth-1": { description: "1A23", enteredAt: "2026-08-05T12:00:00.000Z", runSummary: null },
    },
    signals: {},
  },
};

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useLiveMapSocket", () => {
  it("applies the snapshot and transitions to 'live'", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLiveMapSocket("lancaster"));

    expect(result.current.connectionStatus).toBe("connecting");

    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));

    await waitFor(() => expect(result.current.connectionStatus).toBe("live"));
    expect(result.current.berths).toEqual(snapshot.state.berths);
    expect(result.current.sequence).toBe(10);
  });

  it("applies a berth.updated delta on top of the snapshot", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLiveMapSocket("lancaster"));
    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));
    await waitFor(() => expect(result.current.connectionStatus).toBe("live"));

    act(() =>
      FakeWebSocket.instances[0]!.sendFromServer({
        type: "berth.updated",
        sequence: 11,
        eventAt: "2026-08-05T12:01:00.000Z",
        elementId: "berth-1",
        tdArea: "ZZ",
        berth: "0001",
        description: "1B99",
        enteredAt: "2026-08-05T12:01:00.000Z",
        runSummary: null,
      }),
    );

    await waitFor(() => expect(result.current.berths?.["berth-1"]?.description).toBe("1B99"));
  });

  it("a resync.required message triggers a reconnect (fresh WebSocket) rather than crashing", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLiveMapSocket("lancaster"));
    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));
    await waitFor(() => expect(result.current.connectionStatus).toBe("live"));

    act(() =>
      FakeWebSocket.instances[0]!.sendFromServer({
        type: "resync.required",
        reason: "map_version_changed",
      }),
    );

    await waitFor(() => expect(result.current.connectionStatus).toBe("reconnecting"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
  });

  it("a duplicate/out-of-order (lower) sequence is discarded, not applied, and forces a reconnect", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLiveMapSocket("lancaster"));
    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));
    await waitFor(() => expect(result.current.connectionStatus).toBe("live"));

    expect(() =>
      act(() =>
        FakeWebSocket.instances[0]!.sendFromServer({
          type: "berth.updated",
          sequence: 5, // lower than the snapshot's 10
          eventAt: "2026-08-05T12:01:00.000Z",
          elementId: "berth-1",
          tdArea: "ZZ",
          berth: "0001",
          description: "SHOULD-NOT-APPLY",
          enteredAt: "2026-08-05T12:01:00.000Z",
          runSummary: null,
        }),
      ),
    ).not.toThrow();

    // Discarded, not applied — the stale snapshot value is untouched.
    expect(result.current.berths?.["berth-1"]?.description).toBe("1A23");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
  });
});
