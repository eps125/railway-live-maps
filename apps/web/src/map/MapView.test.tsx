import { render, screen } from "@testing-library/react";
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
        type: "signal",
        x: 60,
        y: 20,
        orientation: 0,
        symbolStyle: "signal-blank",
        label: "L1",
      },
    },
    berthBindingIndex: { "PX|0512": "berth-1" },
    sBitBindingIndex: {},
    boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    topologyAdjacency: {},
    continuationLinks: [],
  },
};

const state: MapStateResponse = {
  mapSlug: "lancaster",
  mapVersion: 1,
  asOf: "2026-08-04T12:00:00.000Z",
  sourceSequence: 1,
  mode: "live",
  quality: { status: "ok", gaps: [] },
  berths: {
    "berth-1": { description: "2A16", enteredAt: "2026-08-04T11:59:00.000Z", runSummary: null },
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
});
