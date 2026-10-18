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
      "berth-1": { description: "1A23", enteredAt: "2026-08-05T12:00:00.000Z" },
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
      }),
    );

    await waitFor(() => expect(result.current.berths?.["berth-1"]?.description).toBe("1B99"));
  });

  it("applies a burst of deltas in one render per frame, latest value per element (Milestone 94)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLiveMapSocket("lancaster");
    });
    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));
    await waitFor(() => expect(result.current.connectionStatus).toBe("live"));
    const before = renders;
    const berthsBefore = result.current.berths;

    act(() => {
      for (let i = 0; i < 20; i += 1) {
        FakeWebSocket.instances[0]!.sendFromServer({
          type: "berth.updated",
          sequence: 11 + i,
          eventAt: "2026-08-05T12:01:00.000Z",
          elementId: `berth-${i % 3}`,
          tdArea: "ZZ",
          berth: "0001",
          description: `1B${String(i).padStart(2, "0")}`,
          enteredAt: "2026-08-05T12:01:00.000Z",
        });
      }
      FakeWebSocket.instances[0]!.sendFromServer({
        type: "berth.cleared",
        sequence: 31,
        eventAt: "2026-08-05T12:01:00.000Z",
        elementId: "berth-2",
        tdArea: "ZZ",
        berth: "0002",
      });
    });
    // Nothing is applied until the frame.
    expect(result.current.berths?.["berth-0"]).toBeUndefined();
    const revisionBefore = result.current.revision;
    await waitFor(() => expect(result.current.sequence).toBe(31));
    expect(renders - before).toBe(1);
    expect(result.current.berths?.["berth-0"]?.description).toBe("1B18");
    expect(result.current.berths?.["berth-1"]?.description).toBe("1B19");
    expect(result.current.berths?.["berth-2"]).toEqual({ description: null, enteredAt: null });
    // Patched in place (the record keeps its identity); the revision says it changed.
    expect(result.current.berths).toBe(berthsBefore);
    expect(result.current.revision).toBe(revisionBefore + 1);
  });

  it("a snapshot supersedes deltas still waiting for the frame (Milestone 94)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLiveMapSocket("lancaster"));
    act(() => {
      FakeWebSocket.instances[0]!.sendFromServer(snapshot);
      FakeWebSocket.instances[0]!.sendFromServer({
        type: "berth.updated",
        sequence: 11,
        eventAt: "2026-08-05T12:01:00.000Z",
        elementId: "berth-1",
        tdArea: "ZZ",
        berth: "0001",
        description: "STALE",
        enteredAt: "2026-08-05T12:01:00.000Z",
      });
      FakeWebSocket.instances[0]!.sendFromServer({ ...snapshot, sequence: 12 });
    });
    await waitFor(() => expect(result.current.sequence).toBe(12));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(result.current.berths?.["berth-1"]?.description).toBe("1A23");
  });

  it("applies a signal.updated delta (Milestone 36b)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLiveMapSocket("blackpool"));
    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));
    await waitFor(() => expect(result.current.connectionStatus).toBe("live"));

    act(() =>
      FakeWebSocket.instances[0]!.sendFromServer({
        type: "signal.updated",
        sequence: 11,
        eventAt: "2026-08-05T12:01:00.000Z",
        elementId: "sig-1",
        state: "off",
        tdArea: "M9",
        address: "03",
        bit: 2,
      }),
    );
    await waitFor(() => expect(result.current.signals?.["sig-1"]).toEqual({ state: "off" }));
  });

  it("a resync.required feed_gap message (Milestone 36b) forces a reconnect for a fresh snapshot", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    renderHook(() => useLiveMapSocket("blackpool"));
    act(() => FakeWebSocket.instances[0]!.sendFromServer(snapshot));
    act(() =>
      FakeWebSocket.instances[0]!.sendFromServer({ type: "resync.required", reason: "feed_gap" }),
    );
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1), {
      timeout: 5_000,
    });
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
