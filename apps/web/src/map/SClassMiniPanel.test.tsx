import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledMapBundle } from "@railway/map-schema";
import { SClassMiniPanel, elementsBoundToBit, sClassAreasForBundle } from "./SClassMiniPanel.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const bundle = {
  schemaVersion: 1,
  mapId: "bpool",
  mapName: "Blackpool",
  canvas: { width: 100, height: 100, gridSize: 10 },
  timezone: "Europe/London",
  layers: [],
  elementsById: {},
  berthBindingIndex: { "PX|0100": "b-1" },
  sBitBindingIndex: { "M9|07|4": "sig-3879" },
  routeBindingIndex: { "M9|0C|4": "route-3879a" },
  inferredBarrierBindings: {
    "lx-carleton": [{ tdArea: "M9", address: "07", bit: 4, activeMeans: "off" as const }],
  },
  placeBindingIndex: [],
  boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  topologyAdjacency: {},
  continuationLinks: [],
} as CompiledMapBundle;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("S-Class mini explorer helpers (Milestone 65)", () => {
  it("offers the areas the map has S-Class bindings in, not just its berth areas", () => {
    expect(sClassAreasForBundle(bundle)).toEqual(["M9"]);
    expect(
      sClassAreasForBundle({
        ...bundle,
        sBitBindingIndex: {},
        routeBindingIndex: {},
        inferredBarrierBindings: {},
      }),
    ).toEqual(["PX"]);
  });

  it("finds every element bound to a bit: signal, route and inferred crossing", () => {
    expect(elementsBoundToBit(bundle, "M9", "07", 4).sort()).toEqual(["lx-carleton", "sig-3879"]);
    expect(elementsBoundToBit(bundle, "M9", "0C", 4)).toEqual(["route-3879a"]);
    expect(elementsBoundToBit(bundle, "M9", "0C", 5)).toEqual([]);
  });
});

describe("SClassMiniPanel (Milestone 65)", () => {
  const snapshot = (at: string) => ({
    at,
    windowSeconds: 120,
    bytes: [
      { address: "07", value: 0x10 },
      { address: "0C", value: null },
    ],
    changes: [
      {
        address: "07",
        bit: 4,
        previousValue: false,
        newValue: true,
        eventAt: new Date(Date.parse(at) - 3000).toISOString(),
      },
    ],
    truncated: false,
    definitions: [{ address: "07", bit: 4, kind: "signal", label: "S3879", destination: null }],
  });

  it("live: shows the bits and changes, and highlights what just changed and what's picked", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(jsonResponse(snapshot(new Date().toISOString()))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onHighlight = vi.fn();
    render(
      <SClassMiniPanel bundle={bundle} atIso={null} onHighlight={onHighlight} onClose={() => {}} />,
    );

    const grid = await screen.findByRole("table", { name: "M9 bits" });
    await waitFor(() => expect(within(grid).getByText("S3879")).toBeInTheDocument());
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /^\/api\/v1\/admin\/s-class\/areas\/M9\/snapshot\?windowSeconds=120$/,
    );
    // An unknown byte reads "?", never a guessed 0.
    expect(within(grid).getAllByText("?")).toHaveLength(8);
    // 07:4 changed 3 s ago: its signal and inferred crossing light up on the map.
    await waitFor(() =>
      expect(onHighlight).toHaveBeenLastCalledWith(
        expect.arrayContaining(["sig-3879", "lx-carleton"]),
      ),
    );

    // Turning off change highlighting and picking the route bit highlights just the route.
    fireEvent.click(screen.getByLabelText("Highlight changes on map"));
    fireEvent.click(within(grid).getByTitle(/^0C:4 = unknown/));
    await waitFor(() => expect(onHighlight).toHaveBeenLastCalledWith(["route-3879a"]));
    expect(screen.getByText(/Bound on this map to route-3879a/)).toBeInTheDocument();
  });

  it("playback: asks for the bits at the playback clock", async () => {
    const at = "2026-09-20T10:00:00.000Z";
    const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse(snapshot(at))));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SClassMiniPanel bundle={bundle} atIso={at} onHighlight={() => {}} onClose={() => {}} />,
    );
    await screen.findByRole("table", { name: "M9 bits" });
    await waitFor(() =>
      expect(String(fetchMock.mock.calls[0]![0])).toContain(`at=${encodeURIComponent(at)}`),
    );
  });
});
