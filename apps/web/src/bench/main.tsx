import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import type { CompiledMapBundle } from "@railway/map-schema";
import type { BerthDelay } from "@railway/protocol";
import { MapView } from "../map/MapView.js";
import { headcode, syntheticBundle, syntheticSnapshotState } from "./syntheticMap.js";
import "../styles.css";

/**
 * Milestone 94 (dev-only): the map-scale benchmark page. Mounts the real public `MapView` against
 * a synthetic (or a locally supplied real) bundle, with `fetch` and `WebSocket` replaced so the
 * live snapshot and deltas come from `window.__bench` instead of a server. Driven by
 * `apps/web/bench/run.mjs` over the Chrome DevTools protocol. Never part of the app build.
 *
 * Query: `?n=<elements>` for a synthetic map, or `?bundle=<url>` for a bundle JSON file;
 * a third of the occupied berths carry a delay band; `&delays=1` starts with "Delay colours" on.
 */

const params = new URLSearchParams(window.location.search);
const slug = "bench";

interface BenchApi {
  ready: boolean;
  mountMs: number | null;
  /** Each React commit's `actualDuration` (ms), in order. */
  commits: number[];
  definitionBytes: number;
  snapshotBytes: number;
  elementCount: number;
  /** Gzipped sizes of the two payloads (what nginx sends). */
  gzipBytes(): Promise<{ definition: number; snapshot: number }>;
  /** Pushes one live delta. Deltas alternate: a train leaves a berth (`berth.cleared`), then
   * steps into the next one (`berth.updated`), so the map stays about as busy as it started. */
  delta(): void;
  /** From now on, deltas go only to berths inside the current view (`true`) or to any berth on
   * the map (`false`, the default). Culling makes off-screen deltas nearly free, so the on-screen
   * case is the one that shows what a busy visible area costs. */
  targetOnScreen(on: boolean): number;
  /** One wheel step, then waits for the zoom to settle and be drawn at its real size; marked
   * `bench:start` / `bench:end` for the trace. */
  zoomSettle(): Promise<void>;
  /** Ticks or unticks the toolbar's "Delay colours" box, as a viewer would. */
  setDelayColours(on: boolean): void;
  /** Pushes one wheel-zoom step at the middle of the window. */
  wheel(deltaY: number): void;
  /** Scrolls the map by `dx` pixels, exactly as a drag does. */
  pan(dx: number): void;
  /** Runs `action(i)` once per animation frame for `frames` frames; resolves with the intervals
   * between frames (ms) and the React commit durations the run produced. */
  perFrame(frames: number, action: "wheel" | "pan" | "none"): Promise<FrameRun>;
  /** Pushes `perSecond` deltas a second for `ms`, each its own task (as socket messages arrive),
   * while recording frame intervals. */
  burst(ms: number, perSecond: number): Promise<FrameRun>;
  /** Pushes `count` single deltas, each after the last one's frame plus `gapMs`, each marked `bench:delta` for the trace;
   * resolves with each one's React commit time. */
  singles(count: number, gapMs: number): Promise<number[]>;
}

interface FrameRun {
  frameIntervals: number[];
  commits: number[];
  wallMs: number;
}

declare global {
  interface Window {
    __bench: BenchApi;
  }
}

async function loadBundle(): Promise<CompiledMapBundle> {
  const url = params.get("bundle");
  if (url) return (await (await fetch(url)).json()) as CompiledMapBundle;
  return syntheticBundle(Number(params.get("n") ?? "1500"));
}

async function main(): Promise<void> {
  const realFetch = window.fetch.bind(window);
  const bundle = await loadBundle();
  const withDelays = params.get("delays") === "1";
  try {
    window.localStorage.clear();
    if (withDelays) window.localStorage.setItem("rlm.delayColours", "true");
  } catch {
    /* ignore */
  }

  const state = syntheticSnapshotState(bundle);
  const berthIds = Object.keys(state.berths);
  // Always in the snapshot, so "Delay colours" can be switched on mid-run; `delays=1` only
  // starts with it on.
  const delays: BerthDelay[] = [];
  {
    let i = 0;
    for (const [elementId, berth] of Object.entries(state.berths)) {
      if (berth.description && i++ % 3 === 0) {
        delays.push({
          runKey: `run-${elementId}`,
          elementId,
          description: berth.description,
          band: "minor",
          matchConfidence: "solid",
        });
      }
    }
  }
  const definitionBody = JSON.stringify({
    mapSlug: slug,
    mapVersion: 1,
    effectiveFrom: "2026-10-18T00:00:00Z",
    effectiveTo: null,
    definition: bundle,
  });
  const snapshotBody = JSON.stringify({
    type: "snapshot",
    protocolVersion: 1,
    sequence: 1,
    state: { mode: "live", quality: { status: "ok", gaps: [] }, ...state, delays },
  });

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(`/maps/${slug}/definition`))
      return Promise.resolve(new Response(definitionBody, { status: 200 }));
    if (url.includes(`/maps/${slug}/`)) return new Promise<Response>(() => {});
    return realFetch(input, init);
  };

  let sequence = 1;
  class FakeSocket extends EventTarget {
    static latest: FakeSocket | null = null;
    readyState = 1;
    constructor(_url: string) {
      super();
      FakeSocket.latest = this;
      setTimeout(() => {
        this.dispatchEvent(new Event("open"));
        this.dispatchEvent(new MessageEvent("message", { data: snapshotBody }));
        snapshotCommit = bench.commits.length;
      }, 0);
    }
    send(): void {}
    close(): void {}
  }
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

  // A pool of trains stepping along the berths: each step clears one berth and fills the next.
  let cursor = 0;
  let snapshotCommit: number | null = null;
  const profiling = import.meta.env.VITE_BENCH_PROFILING !== "0";
  let targets = berthIds;
  function push(message: object): void {
    sequence += 1;
    FakeSocket.latest?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ ...message, sequence }) }),
    );
  }

  const bench: BenchApi = {
    ready: false,
    mountMs: null,
    commits: [],
    definitionBytes: definitionBody.length,
    snapshotBytes: snapshotBody.length,
    elementCount: Object.keys(bundle.elementsById).length,
    async gzipBytes() {
      const gz = async (text: string) =>
        (
          await new Response(
            new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
          ).arrayBuffer()
        ).byteLength;
      return { definition: await gz(definitionBody), snapshot: await gz(snapshotBody) };
    },
    delta() {
      const now = new Date().toISOString();
      if (cursor % 2 === 0) {
        const from = targets[(cursor * 7) % targets.length]!;
        push({ type: "berth.cleared", eventAt: now, elementId: from, tdArea: "SY", berth: "0000" });
      } else {
        const to = targets[((cursor - 1) * 7 + 1) % targets.length]!;
        push({
          type: "berth.updated",
          eventAt: now,
          elementId: to,
          tdArea: "SY",
          berth: "0001",
          description: headcode(cursor),
          enteredAt: now,
        });
      }
      cursor += 1;
    },
    targetOnScreen(on) {
      if (!on) {
        targets = berthIds;
        return targets.length;
      }
      const view = document.querySelector(".map-frame__scroll")?.getAttribute("data-view");
      const [x, y, w, h] = (view ?? "0 0 0 0").split(" ").map(Number) as [
        number,
        number,
        number,
        number,
      ];
      const inside = berthIds.filter((id) => {
        const el = bundle.elementsById[id];
        return el && "x" in el && el.x >= x && el.x <= x + w && el.y >= y && el.y <= y + h;
      });
      targets = inside.length > 1 ? inside : berthIds;
      return inside.length;
    },
    async zoomSettle() {
      performance.mark("bench:start");
      bench.wheel(-100);
      await new Promise((r) => setTimeout(r, 600));
      performance.mark("bench:end");
      bench.wheel(100);
      await new Promise((r) => setTimeout(r, 600));
    },
    setDelayColours(on) {
      const box = [...document.querySelectorAll<HTMLLabelElement>(".map-page__toggle")]
        .find((label) => label.textContent?.includes("Delay colours"))
        ?.querySelector("input");
      if (box && box.checked !== on) box.click();
    },
    wheel(deltaY) {
      const el = document.querySelector<HTMLElement>(".map-frame__scroll")!;
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaMode: 0,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    pan(dx) {
      const el = document.querySelector<HTMLElement>(".map-frame__scroll")!;
      el.scrollLeft += dx;
    },
    perFrame(frames, action) {
      return new Promise((resolve) => {
        const intervals: number[] = [];
        const firstCommit = bench.commits.length;
        const start = performance.now();
        performance.mark("bench:start");
        let last = 0;
        let i = 0;
        function frame(ts: number): void {
          if (last) intervals.push(ts - last);
          last = ts;
          if (i === frames) {
            // One more frame so the last action's work is inside the measurement.
            requestAnimationFrame((end) => {
              intervals.push(end - last);
              performance.mark("bench:end");
              resolve({
                frameIntervals: intervals,
                commits: bench.commits.slice(firstCommit),
                wallMs: performance.now() - start,
              });
            });
            return;
          }
          // Zoom in for 10 steps, out for 10, and so on, so the zoom stays in range; pan likewise.
          const sign = Math.floor(i / 10) % 2 === 0 ? 1 : -1;
          if (action === "wheel") bench.wheel(-100 * sign);
          else if (action === "pan") bench.pan(60 * sign);
          i += 1;
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
    },
    burst(ms, perSecond) {
      return new Promise((resolve) => {
        const intervals: number[] = [];
        const firstCommit = bench.commits.length;
        const start = performance.now();
        performance.mark("bench:start");
        let last = 0;
        let running = true;
        const timer = setInterval(() => bench.delta(), 1000 / perSecond);
        function frame(ts: number): void {
          if (last) intervals.push(ts - last);
          last = ts;
          if (running) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
        setTimeout(() => {
          clearInterval(timer);
          running = false;
          performance.mark("bench:end");
          resolve({
            frameIntervals: intervals,
            commits: bench.commits.slice(firstCommit),
            wallMs: performance.now() - start,
          });
        }, ms);
      });
    },
    async singles(count, gapMs) {
      const each: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const before = bench.commits.length;
        performance.mark("bench:delta");
        bench.delta();
        // Wait for the frame the delta produces, then `gapMs` more, so a slow delta never
        // overlaps the next one's measurement window.
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, gapMs))),
        );
        each.push(bench.commits.slice(before).reduce((a, b) => a + b, 0));
      }
      return each;
    },
  };
  window.__bench = bench;

  const root = document.getElementById("root")!;
  const t0 = performance.now();
  createRoot(root).render(
    <Profiler
      id="map"
      onRender={(_id, _phase, actualDuration) => bench.commits.push(actualDuration)}
    >
      <MapView slug={slug} />
    </Profiler>,
  );

  // Mounted = the SVG is in the document, React has committed the snapshot, and a frame has been
  // produced. (Not "an occupied berth's text is drawn": on a culled map it may be off screen.)
  function check(): void {
    const svg = document.querySelector("svg[role=img]");
    // Without the profiling build there are no commit timings: the snapshot is applied by the
    // time its message task and the next frame have run.
    const drawn = snapshotCommit !== null && (bench.commits.length > snapshotCommit || !profiling);
    if (!svg || !drawn) {
      requestAnimationFrame(check);
      return;
    }
    requestAnimationFrame(() =>
      setTimeout(() => {
        bench.mountMs = performance.now() - t0;
        bench.ready = true;
      }, 0),
    );
  }
  requestAnimationFrame(check);
}

void main();
