import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView.js";
import type { MapDefinitionResponse, MapStateResponse } from "./types.js";

const definition: MapDefinitionResponse = {
  mapSlug: "lancaster",
  mapVersion: 1,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  definition: {
    schemaVersion: 1,
    mapId: "lancaster",
    mapName: "Lancaster",
    canvas: { width: 200, height: 200, gridSize: 10 },
    timezone: "Europe/London",
    layers: [],
    elementsById: {
      "berth-1": {
        id: "berth-1",
        layerId: "l1",
        zIndex: 0,
        type: "berth",
        x: 10,
        y: 10,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "Berth 1",
      },
      "signal-1": {
        id: "signal-1",
        layerId: "l1",
        zIndex: 0,
        type: "signal",
        x: 60,
        y: 20,
        orientation: 0,
        symbolStyle: "signal-blank",
        label: "L1",
      },
      "boundary-1": {
        id: "boundary-1",
        layerId: "l1",
        zIndex: 0,
        type: "boundary",
        x: 90,
        y: 90,
        name: "Preston PSB",
        adjacentMapSlug: "carlisle",
        adjacentBoundaryName: "Carlisle PSB",
      },
      "label-boundary-1": {
        id: "label-boundary-1",
        layerId: "l1",
        zIndex: 0,
        type: "label",
        x: 70,
        y: 70,
        text: "Shap Summit",
        align: "left",
        fontSize: 12,
        adjacentMapSlug: "carlisle",
        adjacentBoundaryName: "Shap Summit",
      },
    },
    berthBindingIndex: { "PX|0512": "berth-1" },
    sBitBindingIndex: {},
    placeBindingIndex: [],
    boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    topologyAdjacency: {},
    continuationLinks: [],
  },
};

// Second map, used only by the "navigating between maps in place" regression test below — a
// distinct boundingBox/boundary position from `definition` so a stale value from the wrong map
// (or the wrong fallback) is unambiguous in the assertion.
const carlisleDefinition: MapDefinitionResponse = {
  mapSlug: "carlisle",
  mapVersion: 1,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  definition: {
    schemaVersion: 1,
    mapId: "carlisle",
    mapName: "Carlisle",
    canvas: { width: 200, height: 200, gridSize: 10 },
    timezone: "Europe/London",
    layers: [],
    elementsById: {
      "label-boundary-2": {
        id: "label-boundary-2",
        layerId: "l1",
        zIndex: 0,
        type: "label",
        x: 40,
        y: 320,
        // Carlisle's own name for this crossing (what a `?boundary=` link from the *other* side
        // must match) — `adjacentBoundaryName` is what lancaster calls the same crossing.
        text: "Carlisle PSB",
        align: "left",
        fontSize: 12,
        adjacentMapSlug: "lancaster",
        adjacentBoundaryName: "Preston PSB",
      },
    },
    berthBindingIndex: {},
    sBitBindingIndex: {},
    placeBindingIndex: [],
    boundingBox: { minX: 0, minY: 200, maxX: 400, maxY: 400 },
    topologyAdjacency: {},
    continuationLinks: [],
  },
};

const carlisleState: MapStateResponse = {
  mapSlug: "carlisle",
  mapVersion: 1,
  asOf: "2026-08-04T12:00:00.000Z",
  sourceSequence: 1,
  mode: "live",
  quality: { status: "ok", gaps: [] },
  berths: {},
  signals: {},
};

const state: MapStateResponse = {
  mapSlug: "lancaster",
  mapVersion: 1,
  asOf: "2026-08-04T12:00:00.000Z",
  sourceSequence: 1,
  mode: "live",
  quality: { status: "ok", gaps: [] },
  berths: {
    "berth-1": { description: "2A16", enteredAt: "2026-08-04T11:59:00.000Z" },
  },
  signals: { "signal-1": { state: "blank" } },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MapView", () => {
  it("renders the live status banner and the current berth description", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/definition")) return Promise.resolve(jsonResponse(definition));
      if (url.includes("/state")) return Promise.resolve(jsonResponse(state));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MapView slug="lancaster" />);

    expect(await screen.findByText("2A16")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /lancaster schematic map/i })).toBeInTheDocument();
  });

  it("shows an alert when the map definition can't be loaded", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<MapView slug="lancaster" />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("recovers once a definition that was 404 at first load gets published", async () => {
    // Reproduces the real bug: the page loads before `publish-map` runs (definition 404s),
    // then the map gets published while the tab is still open — the definition fetch must
    // retry and the page must recover, not stay stuck on the first error forever. Uses real
    // timers (not fake) because @testing-library's findBy*/waitFor polling needs them.
    let definitionCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/definition")) {
        definitionCalls += 1;
        return definitionCalls === 1
          ? Promise.resolve({ ok: false, status: 404 } as Response)
          : Promise.resolve(jsonResponse(definition));
      }
      if (url.includes("/state")) return Promise.resolve(jsonResponse(state));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MapView slug="lancaster" />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(await screen.findByText("2A16", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }, 10_000);

  it("resolves ?boundary=<name> (Milestone 32) to this map's own same-named boundary element and centres there", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/definition")) return Promise.resolve(jsonResponse(definition));
      if (url.includes("/state")) return Promise.resolve(jsonResponse(state));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MapView slug="lancaster" centerBoundaryName="Preston PSB" />);
    await screen.findByText("2A16");

    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(x! + width! / 2).toBeCloseTo(90);
    expect(y! + height! / 2).toBeCloseTo(90);
  });

  it("resolves ?boundary=<name> to a label carrying adjacentMapSlug too, not just the legacy boundary type (Milestone 32, folded into label 2026-09-13)", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/definition")) return Promise.resolve(jsonResponse(definition));
      if (url.includes("/state")) return Promise.resolve(jsonResponse(state));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MapView slug="lancaster" centerBoundaryName="Shap Summit" />);
    await screen.findByText("2A16");

    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(x! + width! / 2).toBeCloseTo(70);
    expect(y! + height! / 2).toBeCloseTo(70);
  });

  it("falls back to the default view when centerBoundaryName matches no boundary on this map (stale/renamed link, never a hard error)", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/definition")) return Promise.resolve(jsonResponse(definition));
      if (url.includes("/state")) return Promise.resolve(jsonResponse(state));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <MapView slug="lancaster" centerBoundaryName="Nonexistent Boundary" />,
    );
    await screen.findByText("2A16");

    // No throw, no alert — just the ordinary default view (bounding-box centre).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(x! + width! / 2).toBeCloseTo(50);
    expect(y! + height! / 2).toBeCloseTo(50);
  });

  it("re-centres on a boundary click-through even when navigating in place between two already-mounted maps (2026-09-16 fix)", async () => {
    // Reproduces the real bug: `navigate()` (apps/web/src/useRoute.ts) is a client-side
    // pushState, so clicking a boundary label on a live page changes this component's `slug`/
    // `centerBoundaryName` props on the *same* React instance rather than remounting it —
    // exactly what `rerender` (not a fresh `render`) simulates here. Before the fix,
    // MapRenderer's mount-only centering refs never re-ran on this in-place prop change, so the
    // view fell back to whatever its very first mount had computed instead of the newly
    // requested boundary point.
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/maps/lancaster/definition"))
        return Promise.resolve(jsonResponse(definition));
      if (url.includes("/maps/lancaster/state")) return Promise.resolve(jsonResponse(state));
      if (url.includes("/maps/carlisle/definition"))
        return Promise.resolve(jsonResponse(carlisleDefinition));
      if (url.includes("/maps/carlisle/state")) return Promise.resolve(jsonResponse(carlisleState));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, rerender } = render(<MapView slug="lancaster" />);
    await screen.findByText("2A16");

    rerender(<MapView slug="carlisle" centerBoundaryName="Carlisle PSB" />);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /carlisle schematic map/i })).toBeInTheDocument(),
    );

    const svg = container.querySelector("svg")!;
    await waitFor(() => {
      const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
      expect(x! + width! / 2).toBeCloseTo(40);
      expect(y! + height! / 2).toBeCloseTo(320);
    });
  });
});
