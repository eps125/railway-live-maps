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
