#!/usr/bin/env node
/* global process, URL, fetch, WebSocket, setTimeout, clearTimeout, console */
// Milestone 94 (dev-only): drives the map-scale bench page (bench/dist, built by `bench:build`) in
// a real, windowed Chrome over the DevTools protocol, and prints a JSON results file and a
// markdown table. No dependencies beyond Node 22 (global WebSocket and fetch).
//
//   node bench/run.mjs [--chrome <path>] [--sizes 1500,5000,10000,20000] [--bundle name=path.json]
//                      [--profiles desktop,mobile] [--out results.json]
//
// `--bundle` adds a real compiled bundle (e.g. one exported from map_version for comparison); it
// is served from its local path and never copied into the repository.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, arg, i, all) =>
        arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
      [],
    ),
);
const chromePath = args.chrome ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sizes = (args.sizes ?? "1500,5000,10000,20000").split(",").map(Number);
const profiles = (args.profiles ?? "desktop,mobile").split(",");
const bundles = args.bundle ? [args.bundle.split("=")] : [];
const outPath = args.out ?? join(here, "results.json");
const distDir = join(here, "dist");
if (!existsSync(join(distDir, "index.html"))) throw new Error("run `pnpm bench:build` first");

// --- static server -------------------------------------------------------------------------
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const extra = bundles.find(([name]) => path === `/bundle-${name}.json`);
  const file = extra ? extra[1] : join(distDir, path === "/" ? "index.html" : path);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- Chrome --------------------------------------------------------------------------------
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  chromePath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "rlm-bench-"))}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1400,950",
    // A bench window behind other windows must keep drawing at full rate.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let version;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  version = await fetch(`http://127.0.0.1:${port}/json/version`).then(
    (r) => r.json(),
    () => null,
  );
}
const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then(
  (r) => r.json(),
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

await send("Page.enable");
await send("Runtime.enable");

async function load(query) {
  await send("Page.navigate", { url: `${origin}/index.html?${query}` });
  for (let i = 0; i < 6000; i++) {
    await sleep(100);
    const ready = await evaluate("window.__bench?.ready === true").catch(() => false);
    if (ready)
      return evaluate(
        "({ mountMs: __bench.mountMs, commits: __bench.commits, definitionBytes: __bench.definitionBytes, snapshotBytes: __bench.snapshotBytes, elementCount: __bench.elementCount, nodes: document.querySelectorAll('svg[role=img] *').length })",
      );
  }
  throw new Error(`timed out loading ${query}`);
}

// --- tracing ------------------------------------------------------------------------------
let traceSink = null;
let dumpCount = 0;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Tracing.dataCollected" && traceSink)
    traceSink.events.push(...msg.params.value);
  if (msg.method === "Tracing.tracingComplete" && traceSink) traceSink.done();
});
const TOP_LEVEL = new Set(["RunTask", "ThreadControllerImpl::RunTask", "ThreadPool_RunTask"]);
/** Evaluates `expression` under a Chrome trace and returns its value plus helpers to read the
 * renderer main thread's busy time (union of top-level tasks) between two trace timestamps. */
async function traced(expression) {
  const events = [];
  const complete = new Promise((resolve) => (traceSink = { events, done: resolve }));
  await send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [
        "toplevel",
        "devtools.timeline",
        "blink.user_timing",
        "disabled-by-default-devtools.timeline",
        "cc",
        "__metadata",
        ...(process.env.BENCH_INVALIDATION
          ? ["disabled-by-default-devtools.timeline.invalidationTracking"]
          : []),
      ],
    },
  });
  const value = await evaluate(expression);
  await send("Tracing.end");
  await complete;
  traceSink = null;
  if (process.env.BENCH_DUMP)
    writeFileSync(`${process.env.BENCH_DUMP}.${++dumpCount}.json`, JSON.stringify(events));
  const userMarks = events.filter(
    (e) => e.name?.startsWith("bench:") && (e.cat ?? "").includes("user_timing"),
  );
  const pid = userMarks[0]?.pid;
  const threads = new Map(
    events
      .filter((e) => e.ph === "M" && e.name === "thread_name" && e.pid === pid)
      .map((e) => [e.tid, e.args.name]),
  );
  const mainTid = [...threads].find(([, name]) => name === "CrRendererMain")?.[0];
  const onMain = events.filter((e) => e.pid === pid && e.tid === mainTid && e.ph === "X");
  const rasterTids = new Set(
    [...threads].filter(([, n]) => /Compositor|Raster|TileWorker/.test(n)).map(([t]) => t),
  );
  const raster = events.filter(
    (e) =>
      e.pid === pid && rasterTids.has(e.tid) && e.ph === "X" && /Raster|ImageDecode/.test(e.name),
  );
  const top = onMain.filter((e) => TOP_LEVEL.has(e.name));
  function union(list, from, to) {
    const spans = list
      .map((e) => [Math.max(e.ts, from), Math.min(e.ts + (e.dur ?? 0), to)])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let cur = null;
    for (const [a, b] of spans) {
      if (!cur || a > cur[1]) {
        if (cur) total += cur[1] - cur[0];
        cur = [a, b];
      } else cur[1] = Math.max(cur[1], b);
    }
    if (cur) total += cur[1] - cur[0];
    return total / 1000;
  }
  const named = (names, from, to) =>
    union(
      onMain.filter((e) => names.includes(e.name)),
      from,
      to,
    );
  function busy(from, to) {
    return {
      main: union(top, from, to),
      style: named(["UpdateLayoutTree"], from, to),
      layout: named(["Layout"], from, to),
      paint: named(["Paint", "PrePaint", "Layerize", "PaintImage", "UpdateLayer"], from, to),
      raster: [...rasterTids].reduce(
        (acc, tid) =>
          acc +
          union(
            raster.filter((e) => e.tid === tid),
            from,
            to,
          ),
        0,
      ),
    };
  }
  const marks = (name) =>
    userMarks
      .filter((e) => e.name === name)
      .map((e) => e.ts)
      .sort((a, b) => a - b);
  return {
    value,
    marks,
    busy,
    window() {
      const from = marks("bench:start")[0];
      const to = marks("bench:end").at(-1);
      return { ...busy(from, to), spanUs: to - from };
    },
  };
}

async function setProfile(profile) {
  if (profile === "mobile") {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  } else {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
}

async function measureCase(profile, label, query, reps) {
  // Mount: median of `reps` fresh loads.
  const mounts = [];
  let info;
  for (let i = 0; i < reps; i++) {
    info = await load(query);
    mounts.push({ mountMs: info.mountMs, reactMs: sum(info.commits) });
  }
  const gzip = await evaluate("__bench.gzipBytes()");
  await sleep(500);

  // Deltas anywhere on the map first (most are off screen on a culled map), then only on berths
  // in view, which is what a busy visible area costs.
  const anyTrace = await traced("__bench.singles(20, 150)");
  const anyMarks = anyTrace.marks("bench:delta");
  const anySingles = anyMarks.map((at, i) => anyTrace.busy(at, anyMarks[i + 1] ?? at + 1_000_000));
  const onScreenBerths = await evaluate("__bench.targetOnScreen(true)");

  // Single deltas, each measured alone (the next starts after its frame plus 150 ms).
  let trace = await traced("__bench.singles(20, 150)");
  const singleReact = trace.value;
  const marks = trace.marks("bench:delta");
  const singles = marks.map((at, i) => trace.busy(at, marks[i + 1] ?? at + 1_000_000));

  // Burst: 50 deltas/s for 5 s — once untraced for frame timing, once traced for main-thread time.
  const burst = await evaluate("__bench.burst(5000, 50)");
  trace = await traced("__bench.burst(5000, 50)");
  const burstWin = trace.window();

  // Wheel zoom: one step per frame for 60 frames.
  await sleep(300);
  const zoom = await evaluate("__bench.perFrame(60, 'wheel')");
  await sleep(300);
  trace = await traced("__bench.perFrame(60, 'wheel')");
  const zoomWin = trace.window();

  // Pan: one 60 px scroll per frame for 60 frames.
  await sleep(300);
  const pan = await evaluate("__bench.perFrame(60, 'pan')");
  await sleep(300);
  trace = await traced("__bench.perFrame(60, 'pan')");
  const panWin = trace.window();

  // One zoom step plus the full redraw once it settles.
  await sleep(300);
  trace = await traced("__bench.zoomSettle()");
  const settleWin = trace.window();

  // Idle frames for reference (what a frame interval looks like on this machine).
  const idle = await evaluate("__bench.perFrame(60, 'none')");

  // The same deltas with "Delay colours" on (matchDelayBands runs on every berth change).
  await evaluate("__bench.setDelayColours(true)");
  await sleep(1000);
  trace = await traced("__bench.singles(20, 150)");
  const dSingleReact = trace.value;
  const dMarks = trace.marks("bench:delta");
  const dSingles = dMarks.map((at, i) => trace.busy(at, dMarks[i + 1] ?? at + 1_000_000));
  const dBurst = await evaluate("__bench.burst(5000, 50)");
  trace = await traced("__bench.burst(5000, 50)");
  const dBurstWin = trace.window();

  return {
    profile,
    label,
    elements: info.elementCount,
    svgNodes: info.nodes,
    definitionKB: info.definitionBytes / 1024,
    snapshotKB: info.snapshotBytes / 1024,
    definitionGzKB: gzip.definition / 1024,
    snapshotGzKB: gzip.snapshot / 1024,
    mountMs: median(mounts.map((m) => m.mountMs)),
    mountReactMs: median(mounts.map((m) => m.reactMs)),
    onScreenBerths,
    anyDeltaMainMs: median(anySingles.map((w) => w.main)),
    zoomSettleMainMs: settleWin.main,
    deltaMainMs: median(singles.map((w) => w.main)),
    deltaStyleLayoutMs: median(singles.map((w) => w.style + w.layout)),
    deltaPaintMs: median(singles.map((w) => w.paint)),
    deltaRasterMs: median(singles.map((w) => w.raster)),
    deltaReactMs: median(singleReact),
    burstBusyPct: (100 * burstWin.main) / (burstWin.spanUs / 1000),
    burstRasterPct: (100 * burstWin.raster) / (burstWin.spanUs / 1000),
    burstReactMsPerSec: sum(burst.commits) / (burst.wallMs / 1000),
    burstCommits: burst.commits.length,
    delaysDeltaMainMs: median(dSingles.map((w) => w.main)),
    delaysDeltaReactMs: median(dSingleReact),
    delaysBurstBusyPct: (100 * dBurstWin.main) / (dBurstWin.spanUs / 1000),
    delaysBurstFrameP50: median(dBurst.frameIntervals),
    delaysBurstFrameP95: pct(dBurst.frameIntervals, 0.95),
    burstFrameP50: median(burst.frameIntervals),
    burstFrameP95: pct(burst.frameIntervals, 0.95),
    zoomMainMsPerStep: zoomWin.main / 60,
    zoomReactMsPerStep: sum(zoom.commits) / 60,
    zoomStyleLayoutMsPerStep: (zoomWin.style + zoomWin.layout) / 60,
    zoomPaintMsPerStep: zoomWin.paint / 60,
    zoomRasterMsPerStep: zoomWin.raster / 60,
    zoomFrameP50: median(zoom.frameIntervals),
    zoomFrameP95: pct(zoom.frameIntervals, 0.95),
    panMainMsPerStep: panWin.main / 60,
    panRasterMsPerStep: panWin.raster / 60,
    panFrameP50: median(pan.frameIntervals),
    panFrameP95: pct(pan.frameIntervals, 0.95),
    idleFrameP50: median(idle.frameIntervals),
  };
}

// `--probe <expression>`: load the first size, evaluate the expression, print it and stop.
if (args.probe) {
  await setProfile(profiles[0]);
  await load(bundles[0] ? `bundle=/bundle-${bundles[0][0]}.json` : `n=${sizes[0]}`);
  if (process.env.BENCH_PROBE_PROFILE) {
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 100 });
    await send("Profiler.start");
    await evaluate(args.probe);
    const { profile } = await send("Profiler.stop");
    const total = new Map();
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (const id of profile.samples) {
      const n = byId.get(id);
      const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
      total.set(key, (total.get(key) ?? 0) + dt);
    }
    console.log(
      [...total]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([k, v]) => `${v.toFixed(1)} ${k}`)
        .join("\n"),
    );
  } else if (process.env.BENCH_PROBE_TRACE) {
    const t = await traced(args.probe);
    console.log(JSON.stringify(t.value));
  } else console.log(JSON.stringify(await evaluate(args.probe), null, 1));
  ws.close();
  chrome.kill();
  server.close();
  process.exit(0);
}

/** One case, given up after `CASE_LIMIT_MS` (a stuck page must not stall the whole run). */
const CASE_LIMIT_MS = Number(process.env.BENCH_CASE_LIMIT_MS ?? 15 * 60_000);
async function guarded(profile, label, query, reps) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ profile, label, error: "timed out" }), CASE_LIMIT_MS);
  });
  try {
    const run = measureCase(profile, label, query, reps).catch((e) => ({
      profile,
      label,
      error: String(e),
    }));
    return await Promise.race([run, limit]);
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
try {
  for (const profile of profiles) {
    await setProfile(profile);
    for (const [name] of bundles) {
      results.push(await guarded(profile, name, `bundle=/bundle-${name}.json`, 3));
      console.error(JSON.stringify(results.at(-1)));
    }
    for (const n of sizes) {
      results.push(await guarded(profile, String(n), `n=${n}`, n >= 10000 ? 1 : 3));
      console.error(JSON.stringify(results.at(-1)));
    }
  }
} finally {
  ws.close();
  chrome.kill();
  server.close();
}

writeFileSync(outPath, JSON.stringify(results, null, 2));
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
console.log(
  "| profile | map | elements | SVG nodes | definition KB (gz) | snapshot KB (gz) | mount ms (React) | 1 delta main / React / style+layout / paint / raster ms | 50/s main busy % (raster %) | 50/s frame p50/p95 | delay colours on: 1 delta main / React ms, 50/s busy %, frame p50/p95 | zoom ms/step main / React / style+layout / paint / raster | zoom frame p50/p95 | pan main / raster ms/step | pan frame p50/p95 |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  console.log(
    `| ${r.profile} | ${r.label} | ${r.elements} | ${r.svgNodes} | ${f(r.definitionKB, 0)} (${f(r.definitionGzKB, 0)}) | ${f(r.snapshotKB, 0)} (${f(r.snapshotGzKB, 0)}) | ${f(r.mountMs, 0)} (${f(r.mountReactMs, 0)}) | ${f(r.deltaMainMs)} / ${f(r.deltaReactMs)} / ${f(r.deltaStyleLayoutMs)} / ${f(r.deltaPaintMs)} / ${f(r.deltaRasterMs)} | ${f(r.burstBusyPct, 0)} (${f(r.burstRasterPct, 0)}) | ${f(r.burstFrameP50)} / ${f(r.burstFrameP95)} | ${f(r.delaysDeltaMainMs)} / ${f(r.delaysDeltaReactMs)}, ${f(r.delaysBurstBusyPct, 0)}, ${f(r.delaysBurstFrameP50)} / ${f(r.delaysBurstFrameP95)} | ${f(r.zoomMainMsPerStep)} / ${f(r.zoomReactMsPerStep)} / ${f(r.zoomStyleLayoutMsPerStep)} / ${f(r.zoomPaintMsPerStep)} / ${f(r.zoomRasterMsPerStep)} | ${f(r.zoomFrameP50)} / ${f(r.zoomFrameP95)} | ${f(r.panMainMsPerStep, 2)} / ${f(r.panRasterMsPerStep, 2)} | ${f(r.panFrameP50)} / ${f(r.panFrameP95)} |`,
  );
}
