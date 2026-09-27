import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocument, MapElement } from "@railway/map-schema";
import { EditorStateProvider, useEditorDispatch, useEditorState } from "./EditorState.js";
import { SignalToolDialog } from "./SignalToolDialog.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const berth = (id: string, x: number): MapElement => ({
  id,
  layerId: "l",
  zIndex: 0,
  type: "berth",
  x,
  y: 88,
  width: 60,
  height: 24,
  displayName: id,
  fontSize: 10,
  textAlign: "center",
});
const signal = (id: string, x: number, extra: Record<string, unknown> = {}): MapElement =>
  ({
    id,
    layerId: "l",
    zIndex: 0,
    type: "signal",
    x,
    y: 100,
    orientation: 0,
    symbolStyle: "signal-blank",
    ...extra,
  }) as MapElement;

function doc(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 400, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", visible: true, locked: false, order: 0 }],
    elements: [
      berth("b1", 0),
      berth("b2", 100),
      signal("a", 70),
      signal("b", 90, { label: "MINE", labelSource: "custom" }),
    ],
    topology: { nodes: [], edges: [] },
    bindings: [
      {
        id: "x1",
        elementId: "a",
        type: "tdSBit",
        tdArea: "CL",
        address: "4",
        bit: 1,
        activeMeans: "off",
      },
      {
        id: "x2",
        elementId: "b",
        type: "tdSBit",
        tdArea: "CL",
        address: "04",
        bit: 2,
        activeMeans: "off",
      },
    ],
    editorMetadata: {},
  };
}

function Probe(): JSX.Element {
  const { document: d } = useEditorState();
  const dispatch = useEditorDispatch();
  return (
    <>
      <pre data-testid="signals">
        {JSON.stringify(d.elements.filter((e) => e.type === "signal"))}
      </pre>
      <button type="button" onClick={() => dispatch({ type: "undo" })}>
        Undo
      </button>
    </>
  );
}

describe("SignalToolDialog (ADR 0017 §5)", () => {
  it("previews from the S-Class labels, applies as one step, and leaves hand-set numbers", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        jsonResponse({
          definitions: [
            { address: "04", bit: 1, kind: "signal", label: "S0491", destination: null },
            { address: "04", bit: 2, kind: "signal", label: "S0492", destination: null },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(
      <EditorStateProvider initialDocument={doc()}>
        <SignalToolDialog onClose={onClose} />
        <Probe />
      </EditorStateProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "Name and orient signals" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/editor/s-class/areas/CL/definitions");
    await screen.findByText(/Numbers: 1 to change, 1 skipped/);
    fireEvent.change(screen.getByPlaceholderText("optional, e.g. CE"), {
      target: { value: "CE" },
    });
    const preview = screen.getByRole("table", { name: "Signal tool preview" });
    await waitFor(() => expect(preview).toHaveTextContent("none → CE0491"));
    expect(preview).toHaveTextContent("skipped: number set by hand");

    // Two signals plus the two berths resized to 40.
    expect(screen.getByText(/Berths: 2 to resize, 2 signals move with them/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply 4 changes" }));
    expect(onClose).toHaveBeenCalled();
    const signals = () => JSON.parse(screen.getByTestId("signals").textContent ?? "[]");
    expect(signals()).toEqual([
      expect.objectContaining({
        id: "a",
        label: "CE0491",
        labelSource: "tool",
        appliesTo: "right",
        side: "above",
      }),
      expect.objectContaining({
        id: "b",
        label: "MINE",
        labelSource: "custom",
        appliesTo: "left",
        side: "below",
      }),
    ]);

    // Both signals moved in 10 with their berths' trimmed ends.
    expect(signals().map((sig: { x: number }) => sig.x)).toEqual([60, 100]);

    // One undo restores every signal.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(signals()[0]).not.toHaveProperty("appliesTo");
    expect(signals()[1]).not.toHaveProperty("appliesTo");
    expect(signals().map((sig: { x: number }) => sig.x)).toEqual([70, 90]);
  });
});
