import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledMapBundle } from "@railway/map-schema";
import { MapRenderer } from "./MapRenderer.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function bundle(overrides: Partial<CompiledMapBundle> = {}): CompiledMapBundle {
  return {
    schemaVersion: 1,
    mapId: "lancaster",
    mapName: "Lancaster",
    canvas: { width: 200, height: 200, gridSize: 10 },
    timezone: "Europe/London",
    layers: [
      { id: "layer-visible", name: "Visible", order: 0, visible: true, locked: false },
      { id: "layer-hidden", name: "Hidden", order: 1, visible: false, locked: false },
    ],
    elementsById: {},
    berthBindingIndex: {},
    sBitBindingIndex: {},
    boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    topologyAdjacency: {},
    continuationLinks: [],
    ...overrides,
  };
}

describe("MapRenderer", () => {
  it("does not render elements on a layer marked not visible, matching the editor canvas", () => {
    const doc = bundle({
      elementsById: {
        "label-shown": {
          id: "label-shown",
          layerId: "layer-visible",
          zIndex: 0,
          type: "label",
          x: 10,
          y: 10,
          text: "Shown Label",
          align: "left",
          fontSize: 12,
        },
        "label-hidden": {
          id: "label-hidden",
          layerId: "layer-hidden",
          zIndex: 0,
          type: "label",
          x: 20,
          y: 20,
          text: "Hidden Label",
          align: "left",
          fontSize: 12,
        },
      },
    });

    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);

    expect(screen.getByText("Shown Label")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Label")).not.toBeInTheDocument();
  });

  it("paints elements in sortElementsForPaint order, not elementsById's own key order", () => {
    // Deliberately inserted with the higher zIndex element first in elementsById, so a bug that
    // trusted Object.values()'s key-insertion order instead of explicitly sorting would paint
    // this in the wrong order.
    const doc = bundle({
      elementsById: {
        "label-front": {
          id: "label-front",
          layerId: "layer-visible",
          zIndex: 10,
          type: "label",
          x: 10,
          y: 10,
          text: "Front",
          align: "left",
          fontSize: 12,
        },
        "label-back": {
          id: "label-back",
          layerId: "layer-visible",
          zIndex: 0,
          type: "label",
          x: 20,
          y: 20,
          text: "Back",
          align: "left",
          fontSize: 12,
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const texts = Array.from(container.querySelectorAll("text")).map((el) => el.textContent);
    expect(texts).toEqual(["Back", "Front"]);
  });

  it("opens the run popup when clicking a populated, bound berth (docs/PROJECT_SPEC.md §5)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0512",
            description: "2A16",
            occupancyEnteredAt: null,
            resolution: {
              status: "unmatched",
              confidence: null,
              resolverVersion: 1,
              candidates: [],
            },
            run: null,
            schedule: null,
            latestMovement: null,
          }),
        ),
      ),
    );

    const doc = bundle({
      elementsById: {
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
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
      },
      berthBindingIndex: { "PX|0512": "berth-1" },
    });

    render(
      <MapRenderer
        bundle={doc}
        berths={{ "berth-1": { description: "2A16", enteredAt: null, runSummary: null } }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("2A16"));

    expect(await screen.findByText("No matching activated schedule found.")).toBeInTheDocument();
  });

  it("shades a matched berth brighter than an ambiguous/unmatched one", () => {
    const doc = bundle({
      elementsById: {
        "berth-matched": {
          id: "berth-matched",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Matched",
        },
        "berth-ambiguous": {
          id: "berth-ambiguous",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 60,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Ambiguous",
        },
      },
    });

    const { container } = render(
      <MapRenderer
        bundle={doc}
        berths={{
          "berth-matched": {
            description: "1S45",
            enteredAt: null,
            runSummary: { status: "matched", text: null, trainRunId: "run-x" },
          },
          "berth-ambiguous": {
            description: "1C61",
            enteredAt: null,
            runSummary: { status: "ambiguous", text: null, trainRunId: null },
          },
        }}
        signals={{}}
      />,
    );

    const rects = container.querySelectorAll("rect");
    const matchedFill = rects[0]!.getAttribute("fill");
    const ambiguousFill = rects[1]!.getAttribute("fill");
    expect(matchedFill).toBe("#388bfd");
    expect(ambiguousFill).not.toBe(matchedFill);
    expect(ambiguousFill).not.toBe("#161d27"); // still occupied, just not the "empty" color either
  });

  it("follows a matched run to its new berth instead of staying stuck on the old one", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        jsonResponse({
          tdArea: "PX",
          berth: "0002",
          description: "1S45",
          occupancyEnteredAt: null,
          resolution: { status: "matched", confidence: 1, resolverVersion: 2, candidates: [] },
          run: {
            runId: "run-x",
            trustTrainId: "T1S4511",
            signallingId: "1S45",
            serviceDate: "2026-08-11",
            activatedAt: null,
            operatorCode: null,
            serviceCode: null,
            lifecycleState: "activated",
            scheduleLink: null,
          },
          schedule: null,
          latestMovement: null,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const doc = bundle({
      elementsById: {
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
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
        "berth-2": {
          id: "berth-2",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 60,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Berth 2",
        },
      },
      berthBindingIndex: { "PX|0001": "berth-1", "PX|0002": "berth-2" },
    });

    const { rerender } = render(
      <MapRenderer
        bundle={doc}
        berths={{
          "berth-1": {
            description: "1S45",
            enteredAt: null,
            runSummary: { status: "matched", text: null, trainRunId: "run-x" },
          },
          "berth-2": { description: null, enteredAt: null, runSummary: null },
        }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("1S45"));
    await screen.findByText(/Matched/);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/areas/PX/berths/0001/");

    // The train steps from berth-1 to berth-2 — same run, new berth.
    rerender(
      <MapRenderer
        bundle={doc}
        berths={{
          "berth-1": { description: null, enteredAt: null, runSummary: null },
          "berth-2": {
            description: "1S45",
            enteredAt: null,
            runSummary: { status: "matched", text: null, trainRunId: "run-x" },
          },
        }}
        signals={{}}
      />,
    );

    await screen.findByText(/Matched/);
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0];
    expect(lastCall).toContain("/areas/PX/berths/0002/");
  });

  it("shows the plain stub, not a popup, for an unbound or empty berth", () => {
    const doc = bundle({
      elementsById: {
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
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
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const rect = container.querySelector("rect")!;
    fireEvent.click(rect);

    expect(screen.getByText("This element has no TD binding.")).toBeInTheDocument();
  });
});
