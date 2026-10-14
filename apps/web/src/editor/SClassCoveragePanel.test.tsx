import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapDocumentSchema, type MapDocument } from "@railway/map-schema";
import { EditorStateProvider, useEditorState } from "./EditorState.js";
import { SClassCoveragePanel } from "./SClassCoveragePanel.js";

function doc(bindings: unknown[], signals: Array<[string, string]>): MapDocument {
  return MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: "m",
      name: "M",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "L", order: 0 }],
    elements: signals.map(([id, label]) => ({
      id,
      type: "signal",
      layerId: "l",
      x: 0,
      y: 0,
      label,
    })),
    bindings,
  });
}
const bit = (id: string, elementId: string) => ({
  id,
  type: "tdSBit",
  elementId,
  tdArea: "CE",
  address: "2C",
  bit: 5,
  activeMeans: "off",
});

function Bindings(): JSX.Element {
  const { document } = useEditorState();
  return <pre data-testid="bindings">{JSON.stringify(document.bindings)}</pre>;
}

afterEach(() => vi.unstubAllGlobals());

describe("SClassCoveragePanel", () => {
  it("shows coverage for the areas bound on the map and lets a double use be marked intended", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            definitions: [
              { address: "2C", bit: 5, kind: "signal", label: "S0101", destination: null },
              { address: "2C", bit: 6, kind: "signal", label: "S0105", destination: null },
            ],
          }),
        } as Response),
      ),
    );
    const start = doc(
      [bit("b1", "s1"), bit("b2", "s2")],
      [
        ["s1", "CE101"],
        ["s2", "CE101"],
      ],
    );
    render(
      <EditorStateProvider initialDocument={start}>
        <SClassCoveragePanel others={[]} />
        <Bindings />
      </EditorStateProvider>,
    );

    expect(await screen.findByText(/Signals bound:/)).toHaveTextContent(
      "Signals bound: 1 of 2 defined",
    );
    expect(screen.getByText("1 bit(s) used more than once")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark as intended" }));
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("bindings").textContent ?? "[]")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "b1", allowDuplicate: true }),
          expect.objectContaining({ id: "b2", allowDuplicate: true }),
        ]),
      ),
    );
    expect(screen.queryByText("1 bit(s) used more than once")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warn about this again" })).toBeInTheDocument();
  });
});
