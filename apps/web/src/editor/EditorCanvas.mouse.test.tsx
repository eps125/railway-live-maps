import { act, fireEvent, render } from "@testing-library/react";
import Konva from "konva";
import { afterEach, describe, expect, it } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { EditorCanvas } from "./EditorCanvas.js";
import { EditorStateProvider, useEditorDispatch } from "./EditorState.js";

/** A signal (with its number) on an unlocked Track layer and a free label on a locked Labels
 * layer — the owner's 2026-11-01 report: labels over things being moved got picked instead. */
function doc(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 400, height: 200, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [
      { id: "track", name: "Track", visible: true, locked: false, order: 0 },
      { id: "labels", name: "Labels", visible: true, locked: true, order: 1 },
    ],
    elements: [
      {
        id: "sig-1",
        layerId: "track",
        zIndex: 0,
        type: "signal",
        x: 100,
        y: 100,
        orientation: 0,
        appliesTo: "right",
        label: "PN123",
        symbolStyle: "signal-blank",
      },
      {
        id: "label-a",
        layerId: "labels",
        zIndex: 0,
        type: "label",
        x: 100,
        y: 100,
        text: "To\nCarlisle",
        align: "center",
        fontSize: 12,
      },
    ],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

function stage(): Konva.Stage {
  const found = Konva.stages[Konva.stages.length - 1];
  if (!found) throw new Error("no stage");
  return found;
}

function textNode(text: string): Konva.Text {
  const node = stage().findOne((n: Konva.Node) => n instanceof Konva.Text && n.text() === text);
  if (!node) throw new Error(`no text ${text}`);
  return node as Konva.Text;
}

function UnlockLabels(): JSX.Element {
  const dispatch = useEditorDispatch();
  return (
    <button
      type="button"
      onClick={() =>
        dispatch({
          type: "dispatchCommand",
          command: {
            type: "setLayerProperty",
            layerId: "labels",
            property: "locked",
            value: false,
          },
        })
      }
    >
      unlock
    </button>
  );
}

afterEach(() => {
  act(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", altKey: false })));
});

describe("EditorCanvas mouse rules (owner report 2026-11-01)", () => {
  it("an element on a locked layer ignores the mouse, and listens again once unlocked", () => {
    const { getByText } = render(
      <EditorStateProvider initialDocument={doc()}>
        <UnlockLabels />
        <EditorCanvas />
      </EditorStateProvider>,
    );
    expect(textNode("To\nCarlisle").listening()).toBe(false);
    expect(textNode("PN123").getParent()?.listening()).toBe(true);

    fireEvent.click(getByText("unlock"));
    expect(textNode("To\nCarlisle").listening()).toBe(true);
  });

  it("a signal's number drags on its own only while Alt is held", () => {
    render(
      <EditorStateProvider initialDocument={doc()}>
        <EditorCanvas />
      </EditorStateProvider>,
    );
    const signalGroup = textNode("PN123").getParent()!;
    expect(textNode("PN123").draggable()).toBe(false);
    expect(signalGroup.draggable()).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true })));
    expect(textNode("PN123").draggable()).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", altKey: false })));
    expect(textNode("PN123").draggable()).toBe(false);
  });
});
