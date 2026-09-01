import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledMapBundle } from "@railway/map-schema";
import { MapRenderer, viewBoxAfterPinch, MIN_ZOOM_WIDTH } from "./MapRenderer.js";

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
        berths={{ "berth-1": { description: "2A16", enteredAt: null } }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("2A16"));

    expect(await screen.findByText("No matching activated schedule found.")).toBeInTheDocument();
  });

  it("closes the popup via its close button", async () => {
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

    const { container } = render(
      <MapRenderer
        bundle={doc}
        berths={{ "berth-1": { description: "2A16", enteredAt: null } }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("2A16"));
    await screen.findByText("No matching activated schedule found.");
    expect(container.querySelector(".map-inspector--run")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container.querySelector(".map-inspector--run")).not.toBeInTheDocument();
  });

  it("a single-finger touch still pans (proves pointer-based interaction is wired up)", () => {
    const doc = bundle();
    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const svg = container.querySelector("svg")!;
    const initialViewBox = svg.getAttribute("viewBox")!;
    const initialWidth = Number(initialViewBox.split(" ")[2]);

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 60, clientY: 100 });

    const newViewBox = svg.getAttribute("viewBox")!;
    const newWidth = Number(newViewBox.split(" ")[2]);
    // Panning moves x/y, never changes width/height.
    expect(newWidth).toBe(initialWidth);
    expect(newViewBox).not.toBe(initialViewBox);
  });

  it("does nothing when clicking an unbound or empty berth — only occupied berths are clickable", () => {
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

    expect(container.querySelector(".map-inspector")).not.toBeInTheDocument();
  });
});

describe("viewBoxAfterPinch", () => {
  const origin = { x: 0, y: 0, width: 1000, height: 1000 };

  it("fingers moving apart (distance grows) zooms in — smaller viewBox, same center", () => {
    const result = viewBoxAfterPinch({ startDistance: 20, origin }, 60);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(333.333); // 1000 * (20/60)
    expect(result!.height).toBeCloseTo(333.333);
    // Center stays fixed: origin's center was (500,500); new box must still center there.
    expect(result!.x + result!.width / 2).toBeCloseTo(500);
    expect(result!.y + result!.height / 2).toBeCloseTo(500);
  });

  it("fingers moving together (distance shrinks) zooms out — larger viewBox", () => {
    const result = viewBoxAfterPinch({ startDistance: 20, origin }, 10);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(2000); // 1000 * (20/10)
  });

  it("never zooms in past MIN_ZOOM_WIDTH", () => {
    const result = viewBoxAfterPinch({ startDistance: 20, origin }, 10_000);
    expect(result!.width).toBe(MIN_ZOOM_WIDTH);
    expect(result!.height).toBe(MIN_ZOOM_WIDTH);
  });

  it("returns null for a zero distance rather than dividing by zero", () => {
    expect(viewBoxAfterPinch({ startDistance: 20, origin }, 0)).toBeNull();
  });
});
