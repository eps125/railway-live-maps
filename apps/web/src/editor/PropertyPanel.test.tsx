import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider, useEditorDispatch, useEditorState } from "./EditorState.js";
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

describe("PropertyPanel map metadata", () => {
  it("shows no home point fields by default, commits X/Y, then clears it (2026-09-16)", async () => {
    render(
      <EditorStateProvider initialDocument={baseDoc()}>
        <PropertyPanel />
      </EditorStateProvider>,
    );

    expect(await screen.findByLabelText("Name (shown as the map heading)")).toHaveValue("m");
    // Unset by default — no Clear button yet.
    expect(screen.queryByText("Clear home point")).not.toBeInTheDocument();

    const xInput = screen.getByLabelText("Home point X");
    const yInput = screen.getByLabelText("Home point Y");
    fireEvent.change(xInput, { target: { value: "120" } });
    fireEvent.blur(xInput);
    fireEvent.change(yInput, { target: { value: "-30" } });
    fireEvent.blur(yInput);
    expect(xInput).toHaveValue(120);
    expect(yInput).toHaveValue(-30);

    const clearButton = await screen.findByText("Clear home point");
    fireEvent.click(clearButton);
    expect(screen.queryByText("Clear home point")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Home point X")).toHaveValue(0);
    expect(screen.getByLabelText("Home point Y")).toHaveValue(0);
  });
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

  it("combines an already-bound berth with another via '+ Combine with another berth' (owner request 2026-09-17)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/td/areas/")) return Promise.resolve(jsonResponse({ berths: [] }));
        if (url.includes("/td/areas")) return Promise.resolve(jsonResponse({ areas: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderPanel(baseDoc(), "berth-a");
    expect(await screen.findByLabelText("TD area")).toHaveValue("PX");

    fireEvent.click(screen.getByText("+ Combine with another berth"));

    // A second member row appears, defaulted to the primary's TD area with an empty berth.
    const memberArea = await screen.findByLabelText("Combined member 2 TD area");
    const memberBerth = screen.getByLabelText("Combined member 2 berth");
    expect(memberArea).toHaveValue("PX");
    expect(memberBerth).toHaveValue("");

    fireEvent.change(memberBerth, { target: { value: "B001" } });
    fireEvent.blur(memberBerth);

    // The primary binding is untouched, and the hint explaining combined-berth display appears.
    expect(await screen.findByText(/Combined berth/)).toBeInTheDocument();
    expect(screen.getByLabelText("TD area")).toHaveValue("PX");
    expect(screen.getByLabelText("Berth")).toHaveValue("0100");
    expect(screen.getByLabelText("Combined member 2 berth")).toHaveValue("B001");
  });

  it("removing a combined berth's second member leaves a plain single binding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/td/areas/")) return Promise.resolve(jsonResponse({ berths: [] }));
        if (url.includes("/td/areas")) return Promise.resolve(jsonResponse({ areas: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const doc = baseDoc();
    doc.bindings = [
      {
        id: "bind-a",
        elementId: "berth-a",
        type: "tdBerth",
        tdArea: "PX",
        berth: "0100",
        allowDuplicate: false,
        combinedOrder: 1,
      },
      {
        id: "bind-a2",
        elementId: "berth-a",
        type: "tdBerth",
        tdArea: "PX",
        berth: "0101",
        allowDuplicate: false,
        combinedOrder: 2,
      },
    ];
    renderPanel(doc, "berth-a");

    expect(await screen.findByLabelText("Combined member 2 berth")).toHaveValue("0101");
    fireEvent.click(screen.getByText("Remove"));

    expect(screen.queryByLabelText("Combined member 2 berth")).not.toBeInTheDocument();
    expect(screen.getByLabelText("TD area")).toHaveValue("PX");
    expect(screen.getByLabelText("Berth")).toHaveValue("0100");
  });
});

describe("PropertyPanel Inhibited by", () => {
  it("labels each option with its TD area + berth (not the ambiguous 4-char displayName), falling back to '(unbound)'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/td/areas/")) return Promise.resolve(jsonResponse({ berths: [] }));
        if (url.includes("/td/areas")) return Promise.resolve(jsonResponse({ areas: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderPanel(baseDoc(), "berth-b");

    const select = await screen.findByLabelText("Inhibited by");
    const optionTexts = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    // berth-a is bound to PX/0100 — shown as "PX 0100", not its displayName "Berth A". berth-b
    // itself is excluded (an element can't be inhibited by itself).
    expect(optionTexts).toEqual(["(none)", "PX 0100"]);

    fireEvent.change(select, { target: { value: "berth-a" } });
    expect(select).toHaveValue("berth-a");
  });

  it("shows the unbound fallback label for a berth with no TD binding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/td/areas/")) return Promise.resolve(jsonResponse({ berths: [] }));
        if (url.includes("/td/areas")) return Promise.resolve(jsonResponse({ areas: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    // Select berth-a this time, so the only other option is berth-b (unbound).
    renderPanel(baseDoc(), "berth-a");

    const select = await screen.findByLabelText("Inhibited by");
    const optionTexts = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionTexts).toEqual(["(none)", "Berth B (unbound)"]);
  });
});

function docWithLabel(): MapDocument {
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
        id: "label-a",
        layerId: "l",
        zIndex: 0,
        type: "label",
        x: 10,
        y: 10,
        text: "Platform 1",
        align: "left",
        fontSize: 12,
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

function docWithBoundary(): MapDocument {
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
        id: "boundary-a",
        layerId: "l",
        zIndex: 0,
        type: "boundary",
        x: 10,
        y: 10,
        name: "Preston PSB",
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

describe("PropertyPanel boundary fields", () => {
  it("commits Adjacent map slug and Adjacent boundary name independently of the boundary's own Name (Milestone 32 — sides name a boundary differently)", async () => {
    render(
      <EditorStateProvider initialDocument={docWithBoundary()}>
        <Select id="boundary-a" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    expect(await screen.findByLabelText("Name")).toHaveValue("Preston PSB");

    const slugInput = screen.getByLabelText("Adjacent map slug");
    fireEvent.change(slugInput, { target: { value: "carlisle" } });
    fireEvent.blur(slugInput);
    expect(slugInput).toHaveValue("carlisle");

    const adjacentNameInput = screen.getByLabelText("Adjacent boundary name");
    expect(adjacentNameInput).toHaveValue("");
    fireEvent.change(adjacentNameInput, { target: { value: "Carlisle PSB" } });
    fireEvent.blur(adjacentNameInput);
    expect(adjacentNameInput).toHaveValue("Carlisle PSB");

    // The element's own Name is untouched by setting the adjacent-side name.
    expect(screen.getByLabelText("Name")).toHaveValue("Preston PSB");
  });
});

describe("PropertyPanel label fields", () => {
  it("shows and commits the label's font size", async () => {
    render(
      <EditorStateProvider initialDocument={docWithLabel()}>
        <Select id="label-a" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    const fontSizeInput = await screen.findByLabelText("Font size");
    expect(fontSizeInput).toHaveValue(12);

    fireEvent.change(fontSizeInput, { target: { value: "20" } });
    fireEvent.blur(fontSizeInput);

    expect(fontSizeInput).toHaveValue(20);
  });

  it("commits CRS/TIPLOC/STANOX place identifiers, upper-casing CRS (Milestone 31)", async () => {
    render(
      <EditorStateProvider initialDocument={docWithLabel()}>
        <Select id="label-a" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    const crsInput = await screen.findByLabelText("CRS");
    fireEvent.change(crsInput, { target: { value: "bhj" } });
    fireEvent.blur(crsInput);
    expect(crsInput).toHaveValue("BHJ");

    const tiplocInput = screen.getByLabelText("TIPLOC");
    fireEvent.change(tiplocInput, { target: { value: "BAYHORS" } });
    fireEvent.blur(tiplocInput);
    expect(tiplocInput).toHaveValue("BAYHORS");

    const stanoxInput = screen.getByLabelText("STANOX");
    fireEvent.change(stanoxInput, { target: { value: "54321" } });
    fireEvent.blur(stanoxInput);
    expect(stanoxInput).toHaveValue("54321");
  });

  it("commits Adjacent map slug and Adjacent boundary name on a label (Milestone 32, folded into label 2026-09-13)", async () => {
    render(
      <EditorStateProvider initialDocument={docWithLabel()}>
        <Select id="label-a" />
        <PropertyPanel />
      </EditorStateProvider>,
    );

    const slugInput = await screen.findByLabelText("Adjacent map slug");
    fireEvent.change(slugInput, { target: { value: "carlisle" } });
    fireEvent.blur(slugInput);
    expect(slugInput).toHaveValue("carlisle");

    const adjacentNameInput = screen.getByLabelText("Adjacent boundary name");
    fireEvent.change(adjacentNameInput, { target: { value: "Carlisle PSB" } });
    fireEvent.blur(adjacentNameInput);
    expect(adjacentNameInput).toHaveValue("Carlisle PSB");

    // The label's own Text is untouched by setting the adjacent-side fields.
    expect(screen.getByLabelText("Text (newlines wrap)")).toHaveValue("Platform 1");
  });
});

function docWithStation(): MapDocument {
  const doc = baseDoc();
  doc.elements.push({
    id: "station-a",
    layerId: "l",
    zIndex: 0,
    type: "station",
    x: 10,
    y: 10,
    name: "Lancaster",
    fontSize: 16,
  });
  return doc;
}

function docWithNeutralSection(): MapDocument {
  const doc = baseDoc();
  doc.elements.push({
    id: "ns-a",
    layerId: "l",
    zIndex: 0,
    type: "neutralSection",
    x: 30,
    y: 40,
    size: 20,
    labelPosition: "below",
    fontSize: 10,
  });
  return doc;
}

describe("PropertyPanel station fields", () => {
  it("edits the name in a textarea so it can hold newlines (2026-09-20)", async () => {
    renderPanel(docWithStation(), "station-a");

    const nameField = await screen.findByLabelText("Name");
    expect(nameField.tagName).toBe("TEXTAREA");

    fireEvent.change(nameField, { target: { value: "Lancaster\nCastle Junction" } });
    fireEvent.blur(nameField);
    expect(nameField).toHaveValue("Lancaster\nCastle Junction");
  });

  it("flattens a multi-line station name in a berth's station picker", async () => {
    const doc = docWithStation();
    const station = doc.elements.find((el) => el.id === "station-a")!;
    if (station.type === "station") station.name = "Lancaster\nCastle Junction";
    renderPanel(doc, "berth-a");

    const picker = await screen.findByLabelText("Station");
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toContain(
      "Lancaster Castle Junction",
    );
  });
});

describe("PropertyPanel neutral section fields (Milestone 53)", () => {
  it("commits the label, its position, and the board size", async () => {
    renderPanel(docWithNeutralSection(), "ns-a");

    const labelField = await screen.findByLabelText("Label");
    fireEvent.change(labelField, { target: { value: "Carnforth NS" } });
    fireEvent.blur(labelField);
    expect(labelField).toHaveValue("Carnforth NS");

    const position = screen.getByLabelText("Label position");
    expect(position).toHaveValue("below");
    fireEvent.change(position, { target: { value: "above" } });
    expect(position).toHaveValue("above");

    const size = screen.getByLabelText("Size");
    expect(size).toHaveValue(20);
    fireEvent.change(size, { target: { value: "30" } });
    fireEvent.blur(size);
    expect(size).toHaveValue(30);
  });

  it("snaps back to the stored size rather than accepting a non-positive one the schema rejects", async () => {
    renderPanel(docWithNeutralSection(), "ns-a");

    const size = await screen.findByLabelText("Size");
    fireEvent.change(size, { target: { value: "0" } });
    fireEvent.blur(size);
    expect(size).toHaveValue(20);
  });

  it("offers no binding fields \u2014 a neutral section is display-only", async () => {
    renderPanel(docWithNeutralSection(), "ns-a");

    await screen.findByLabelText("Label position");
    expect(screen.queryByLabelText("TD area")).toBeNull();
    expect(screen.queryByRole("button", { name: /bind/i })).toBeNull();
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

describe("PropertyPanel S-Class signal binding (Milestone 36c)", () => {
  function signalDoc(): MapDocument {
    const doc = baseDoc();
    return {
      ...doc,
      elements: [
        ...doc.elements,
        {
          id: "sig-1",
          layerId: "l",
          zIndex: 0,
          type: "signal",
          x: 10,
          y: 10,
          orientation: 0,
          symbolStyle: "signal-blank",
        },
      ],
    };
  }

  /** Renders the document's S-Class bindings so the test can assert what was committed. */
  function BindingsProbe(): JSX.Element {
    const { document: doc } = useEditorState();
    return (
      <pre data-testid="bindings">
        {JSON.stringify(doc.bindings.filter((b) => b.type === "tdSBit"))}
      </pre>
    );
  }

  it("binds a signal to a defined bit, with activeMeans, and can use the definition's label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/editor/s-class/areas")) {
          return Promise.resolve(jsonResponse({ areas: ["M9"] }));
        }
        if (url.includes("/editor/s-class/areas/M9/definitions")) {
          return Promise.resolve(
            jsonResponse({
              definitions: [
                { address: "03", bit: 2, kind: "signal", label: "S3003", destination: null },
                { address: "05", bit: 0, kind: "route", label: "R3003", destination: "IL1" },
              ],
            }),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(
      <EditorStateProvider initialDocument={signalDoc()}>
        <Select id="sig-1" />
        <PropertyPanel />
        <BindingsProbe />
      </EditorStateProvider>,
    );

    const bindButton = await screen.findByRole("button", { name: "Bind signal" });
    expect(bindButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("TD area"), { target: { value: "m9" } });
    // Only signal definitions are offered (the route is not).
    const defined = await screen.findByLabelText("Defined signal");
    expect(screen.queryByText(/R3003/)).not.toBeInTheDocument();
    fireEvent.change(defined, { target: { value: "03:2" } });
    expect(screen.getByLabelText("Address (hex)")).toHaveValue("03");
    expect(screen.getByLabelText("Bit (0-7)")).toHaveValue("2");

    fireEvent.click(screen.getByRole("button", { name: "Bind signal" }));
    const committed = JSON.parse(screen.getByTestId("bindings").textContent ?? "[]");
    expect(committed).toEqual([
      expect.objectContaining({
        elementId: "sig-1",
        type: "tdSBit",
        tdArea: "M9",
        address: "03",
        bit: 2,
        activeMeans: "off",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Use as label" }));
    expect(await screen.findByLabelText("Label")).toHaveValue("S3003");
  });

  it("won't bind until the address is hex and the bit is 0-7", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ areas: [], definitions: [] }))),
    );
    render(
      <EditorStateProvider initialDocument={signalDoc()}>
        <Select id="sig-1" />
        <PropertyPanel />
      </EditorStateProvider>,
    );
    fireEvent.change(await screen.findByLabelText("TD area"), { target: { value: "M9" } });
    fireEvent.change(screen.getByLabelText("Address (hex)"), { target: { value: "0G" } });
    fireEvent.change(screen.getByLabelText("Bit (0-7)"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Bind signal" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Address (hex)"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Bit (0-7)"), { target: { value: "8" } });
    expect(screen.getByRole("button", { name: "Bind signal" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Bit (0-7)"), { target: { value: "7" } });
    expect(screen.getByRole("button", { name: "Bind signal" })).toBeEnabled();
  });
});
