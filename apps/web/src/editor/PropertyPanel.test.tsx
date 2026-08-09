import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider, useEditorDispatch } from "./EditorState.js";
import { PropertyPanel } from "./PropertyPanel.js";

function baseDoc(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 200, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", visible: true, locked: false, order: 0 }],
    elements: [
      {
        id: "berth-a",
        layerId: "l",
        zIndex: 0,
        type: "berth",
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "Berth A",
        bindingId: "bind-a",
      },
      {
        id: "berth-b",
        layerId: "l",
        zIndex: 0,
        type: "berth",
        x: 50,
        y: 0,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "Berth B",
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [
      {
        id: "bind-a",
        elementId: "berth-a",
        type: "tdBerth",
        tdArea: "PX",
        berth: "0100",
        allowDuplicate: false,
      },
    ],
    editorMetadata: {},
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Selects the given element on mount/update — a stand-in for clicking it on the canvas. */
function Select({ id }: { id: string }): null {
  const dispatch = useEditorDispatch();
  useEffect(() => dispatch({ type: "setSelection", ids: [id] }), [dispatch, id]);
  return null;
}

function SelectMultiple({ ids }: { ids: string[] }): null {
  const dispatch = useEditorDispatch();
  useEffect(() => dispatch({ type: "setSelection", ids }), [dispatch, ids]);
  return null;
}

function docWithLayers(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 200, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [
      { id: "layer-track", name: "Track", visible: true, locked: false, order: 0 },
      { id: "layer-berths", name: "Berths", visible: true, locked: false, order: 1 },
    ],
    elements: [
      {
        id: "berth-a",
        layerId: "layer-track",
        zIndex: 0,
        type: "berth",
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "Berth A",
      },
      {
        id: "berth-b",
        layerId: "layer-track",
        zIndex: 0,
        type: "berth",
        x: 50,
        y: 0,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "Berth B",
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

function renderPanel(initialDocument: MapDocument, selectedId: string) {
  return render(
    <EditorStateProvider initialDocument={initialDocument}>
      <Select id={selectedId} />
      <PropertyPanel />
    </EditorStateProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PropertyPanel BindingFields", () => {
  it("does not keep showing the previous element's binding after selecting a different one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/td/areas/")) return Promise.resolve(jsonResponse({ berths: [] }));
        if (url.includes("/td/areas")) return Promise.resolve(jsonResponse({ areas: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { rerender } = renderPanel(baseDoc(), "berth-a");

    expect(await screen.findByLabelText("TD area")).toHaveValue("PX");
    expect(screen.getByLabelText("Berth")).toHaveValue("0100");

    // Same EditorStateProvider position in the tree, so its useReducer keeps its existing
    // state — `initialDocument` here is inert (useReducer only reads it on first mount).
    // What actually changes selection is <Select id="berth-b" />'s effect.
    rerender(
      <EditorStateProvider initialDocument={baseDoc()}>
        <Select id="berth-b" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    // berth-b has no binding — the fields must reset, not keep showing berth-a's PX/0100.
    expect(screen.getByLabelText("TD area")).toHaveValue("");
    expect(screen.getByLabelText("Berth")).toHaveValue("");
  });

  it("saves a binding on a freshly created, never-bound berth once both fields are filled in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/td/areas/")) return Promise.resolve(jsonResponse({ berths: [] }));
        if (url.includes("/td/areas")) return Promise.resolve(jsonResponse({ areas: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderPanel(baseDoc(), "berth-b");

    const areaInput = await screen.findByLabelText("TD area");
    const berthInput = screen.getByLabelText("Berth");

    // Fill in and blur the area field first — with the old defaultValue-based fields, this
    // blur alone used to silently no-op (berth still empty) and lose the just-typed area.
    fireEvent.change(areaInput, { target: { value: "PX" } });
    fireEvent.blur(areaInput);
    fireEvent.change(berthInput, { target: { value: "0186" } });
    fireEvent.blur(berthInput);

    expect(await screen.findByText("Clear binding")).toBeInTheDocument();
    expect(areaInput).toHaveValue("PX");
    expect(berthInput).toHaveValue("0186");
  });
});

describe("PropertyPanel layer reassignment", () => {
  it("shows the selected element's current layer and moves it when changed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ areas: [] }))),
    );

    render(
      <EditorStateProvider initialDocument={docWithLayers()}>
        <Select id="berth-a" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    const layerSelect = await screen.findByLabelText("Layer");
    expect(layerSelect).toHaveValue("layer-track");

    fireEvent.change(layerSelect, { target: { value: "layer-berths" } });
    expect(layerSelect).toHaveValue("layer-berths");
  });

  it("moves every selected element to the chosen layer in one action", async () => {
    // Regression test: a real hand-authored map ended up with ~50 elements stuck on the wrong
    // layer (EditorCanvas.tsx's defaultElementForTool bug), and one-at-a-time reassignment would
    // have been painfully slow — this bulk action is how it's meant to be fixed instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ areas: [] }))),
    );

    const { rerender } = render(
      <EditorStateProvider initialDocument={docWithLayers()}>
        <SelectMultiple ids={["berth-a", "berth-b"]} />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    expect(await screen.findByText("2 elements selected.")).toBeInTheDocument();
    const moveSelect = screen.getByLabelText("Move to layer");
    fireEvent.change(moveSelect, { target: { value: "layer-berths" } });

    // Same EditorStateProvider tree position, so its dispatched changes persist — switch to
    // selecting berth-b alone to inspect the bulk move actually reached both elements.
    rerender(
      <EditorStateProvider initialDocument={docWithLayers()}>
        <Select id="berth-b" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    expect(await screen.findByLabelText("Layer")).toHaveValue("layer-berths");
  });
});
