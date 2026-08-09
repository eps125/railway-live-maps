import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CompiledMapBundle } from "@railway/map-schema";
import { MapRenderer } from "./MapRenderer.js";

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
});
