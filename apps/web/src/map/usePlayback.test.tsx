import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPlaybackDelta,
  applyPlaybackRouteDelta,
  applyPlaybackSignalDelta,
  usePlayback,
} from "./usePlayback.js";
import type { PlaybackDelta } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("applyPlaybackDelta", () => {
  it("berth.updated sets description + enteredAt for the element", () => {
    const next = applyPlaybackDelta(
      {},
      {
        type: "berth.updated",
        sequence: 1,
        eventAt: "2026-09-03T10:00:00.000Z",
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
        description: "1S99",
        enteredAt: "2026-09-03T10:00:00.000Z",
      },
    );
    expect(next["berth-1"]).toEqual({
      description: "1S99",
      enteredAt: "2026-09-03T10:00:00.000Z",
    });
  });

  it("berth.cleared blanks the element and leaves others untouched", () => {
    const start = {
      "berth-1": { description: "1S99", enteredAt: "x" },
      "berth-2": { description: "2A16", enteredAt: "y" },
    };
    const next = applyPlaybackDelta(start, {
      type: "berth.cleared",
      sequence: 2,
      eventAt: "2026-09-03T10:01:00.000Z",
      elementId: "berth-1",
      tdArea: "PX",
      berth: "0512",
    });
    expect(next["berth-1"]).toEqual({ description: null, enteredAt: null });
    expect(next["berth-2"]).toEqual({ description: "2A16", enteredAt: "y" });
  });
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function HookProbe({ slug, fromMs }: { slug: string; fromMs: number }): JSX.Element {
  const pb = usePlayback(slug, fromMs);
  return (
    <div>
      <span data-testid="loading">{String(pb.loading)}</span>
      <span data-testid="b1">{pb.berths["berth-1"]?.description ?? "none"}</span>
      <span data-testid="atIso">{pb.atIso}</span>
      <span data-testid="gaps">{pb.quality.gaps.join("|")}</span>
    </div>
  );
}

describe("applyPlaybackSignalDelta (Milestone 36b)", () => {
  const signalDelta = {
    type: "signal.updated" as const,
    sequence: 5,
    eventAt: "2026-05-02T10:00:00.000Z",
    elementId: "sig-1",
    state: "on" as const,
    tdArea: "M9",
    address: "03",
    bit: 2,
  };

  it("sets the element's absolute state and leaves others untouched", () => {
    const next = applyPlaybackSignalDelta(
      { "sig-1": { state: "blank" }, "sig-2": { state: "off" } },
      signalDelta,
    );
    expect(next).toEqual({ "sig-1": { state: "on" }, "sig-2": { state: "off" } });
  });

  it("signal events don't touch berths, and berth events don't touch signals", () => {
    const berths = { "berth-1": { description: "1A23", enteredAt: "x" } };
    expect(applyPlaybackDelta(berths, signalDelta)).toBe(berths);
    const signals = { "sig-1": { state: "off" as const } };
    expect(
      applyPlaybackSignalDelta(signals, {
        type: "berth.cleared",
        sequence: 6,
        eventAt: "2026-05-02T10:00:00.000Z",
        elementId: "berth-1",
        tdArea: "M9",
        berth: "0001",
      }),
    ).toBe(signals);
  });
});

describe("usePlayback", () => {
  it("seeds berth + quality state from /state?at= and /events on mount", async () => {
    const at = Date.parse("2026-09-03T09:00:00.000Z");
    const events: PlaybackDelta[] = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/state")) {
        return Promise.resolve(
          jsonResponse({
            mapSlug: "lancaster",
            mapVersion: 1,
            asOf: "2026-09-03T09:00:00.000Z",
            sourceSequence: 10,
            mode: "historical",
            quality: { status: "stale", gaps: ["TD PX feed gap 09:00–09:05 (unrecoverable; x)"] },
            berths: { "berth-1": { description: "4S45", enteredAt: "2026-09-03T08:55:00.000Z" } },
            signals: {},
          }),
        );
      }
      if (url.includes("/events")) {
        return Promise.resolve(
          jsonResponse({ mapSlug: "lancaster", mapVersion: 1, events, nextCursor: null }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HookProbe slug="lancaster" fromMs={at} />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("b1").textContent).toBe("4S45");
    expect(screen.getByTestId("atIso").textContent).toBe("2026-09-03T09:00:00.000Z");
    expect(screen.getByTestId("gaps").textContent).toContain("feed gap");
    // both a /state and an /events request went out for the seed
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/state?at="))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/events?from="))).toBe(true);
    // the seed asks for a full page, not the 100-row default
    expect(
      fetchMock.mock.calls.some(
        ([u]) => String(u).includes("/events?") && String(u).includes("limit=500"),
      ),
    ).toBe(true);
  });

  it("keeps paginating past the first /events page — refills with the `after` cursor before the buffer runs dry", async () => {
    vi.useFakeTimers();
    const at = Date.now() - 60_000;
    // First page: three deltas, all in the near future of `at`, and a non-null cursor.
    const page1: PlaybackDelta[] = [1, 2, 3].map((i) => ({
      type: "berth.updated" as const,
      sequence: i,
      eventAt: new Date(at + i * 1_000).toISOString(),
      elementId: "berth-1",
      tdArea: "PX",
      berth: "0512",
      description: `10${i}`,
      enteredAt: new Date(at + i * 1_000).toISOString(),
    }));
    const page2: PlaybackDelta[] = [
      {
        type: "berth.updated",
        sequence: 4,
        eventAt: new Date(at + 20_000).toISOString(),
        elementId: "berth-1",
        tdArea: "PX",
        berth: "0512",
        description: "PAGE2",
        enteredAt: new Date(at + 20_000).toISOString(),
      },
    ];
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/state")) {
        return Promise.resolve(
          jsonResponse({
            mapSlug: "lancaster",
            mapVersion: 1,
            asOf: new Date(at).toISOString(),
            sourceSequence: 1,
            mode: "historical",
            quality: { status: "ok", gaps: [] },
            berths: {},
            signals: {},
          }),
        );
      }
      if (url.includes("after=")) {
        return Promise.resolve(
          jsonResponse({ mapSlug: "lancaster", mapVersion: 1, events: page2, nextCursor: null }),
        );
      }
      return Promise.resolve(
        jsonResponse({ mapSlug: "lancaster", mapVersion: 1, events: page1, nextCursor: "cur-1" }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    function Probe(): JSX.Element {
      const pb = usePlayback("lancaster", at);
      return (
        <div>
          <span data-testid="b1">{pb.berths["berth-1"]?.description ?? "none"}</span>
          <button type="button" onClick={pb.play}>
            play
          </button>
        </div>
      );
    }
    render(<Probe />);
    await vi.runOnlyPendingTimersAsync(); // resolve seed
    screen.getByText("play").click();
    // advance the playback clock past all three page-1 events and into page-2 territory
    for (let i = 0; i < 60; i += 1) await vi.advanceTimersByTimeAsync(500);

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("after=cur-1"))).toBe(true);
    expect(screen.getByTestId("b1").textContent).toBe("PAGE2");
  });

  it("keeps retrying refill after a null-cursor page instead of stalling forever — the buffer-freeze regression", async () => {
    // Real incident (2026-09-15): a quiet map's initial /events page routinely comes back with
    // fewer than the row cap (`nextCursor: null`) well before the 30-minute buffer window it
    // asked for is actually exhausted of *real* events — that's "caught up to what was asked
    // for," not "nothing more will ever exist." The old code treated a null cursor as a
    // permanent stop, so trains froze once the buffer ran out and never resumed, even on a later
    // tick with a `to` bound that had moved well past the exhausted one.
    vi.useFakeTimers();
    const at = Date.now() - 60_000;
    let eventsCallCount = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/state")) {
        return Promise.resolve(
          jsonResponse({
            mapSlug: "lancaster",
            mapVersion: 1,
            asOf: new Date(at).toISOString(),
            sourceSequence: 1,
            mode: "historical",
            quality: { status: "ok", gaps: [] },
            berths: {},
            signals: {},
          }),
        );
      }
      // Every /events call — the seed's own fetch and every refill — comes back genuinely empty
      // with a null cursor, simulating a quiet map with nothing left in any queried window.
      eventsCallCount += 1;
      return Promise.resolve(
        jsonResponse({ mapSlug: "lancaster", mapVersion: 1, events: [], nextCursor: null }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    function Probe(): JSX.Element {
      const pb = usePlayback("lancaster", at);
      return (
        <button type="button" onClick={pb.play}>
          play
        </button>
      );
    }
    render(<Probe />);
    await vi.runOnlyPendingTimersAsync(); // resolve seed — one /events call, nextCursor: null
    expect(eventsCallCount).toBe(1);

    screen.getByText("play").click();
    // Many ticks at the default (1×) speed, well within the live-edge cap — the empty buffer
    // stays under the refill threshold the whole time, so every tick should attempt another
    // refill rather than giving up after the first null cursor.
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(200);

    expect(eventsCallCount).toBeGreaterThan(1);
  });
});

describe("applyPlaybackRouteDelta (Milestone 64 / ADR 0016)", () => {
  const route = (state: "blank" | "set" | "unset"): PlaybackDelta => ({
    type: "route.updated",
    sequence: 1,
    eventAt: "2026-09-22T12:00:00Z",
    elementId: "route-1",
    state,
    tdArea: "M9",
    address: "0C",
    bit: 4,
  });

  it("applies a route's absolute state, idempotently, and leaves berths and signals alone", () => {
    const set = applyPlaybackRouteDelta({}, route("set"));
    expect(set).toEqual({ "route-1": { state: "set" } });
    expect(applyPlaybackRouteDelta(set, route("set"))).toEqual(set);
    expect(applyPlaybackRouteDelta(set, route("blank"))).toEqual({ "route-1": { state: "blank" } });
    const berths = { b: { description: "1A23", enteredAt: "2026-09-22T11:59:00Z" } };
    expect(applyPlaybackDelta(berths, route("set"))).toBe(berths);
    expect(applyPlaybackSignalDelta({}, route("set"))).toEqual({});
  });
});
