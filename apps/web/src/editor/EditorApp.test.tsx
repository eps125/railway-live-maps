import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorApp } from "./EditorApp.js";
import type { MapDocument } from "@railway/map-schema";

function draftDoc(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "lancaster",
      name: "Lancaster",
      canvas: { width: 400, height: 300, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "layer-default", name: "Default", visible: true, locked: false, order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EditorApp (Konva smoke test)", () => {
  it("loads a draft and renders the editor workspace (canvas + toolbar + panels) without crashing", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/draft")) {
        return Promise.resolve(
          jsonResponse({ slug: "lancaster", revision: 1, canonicalDocument: draftDoc() }),
        );
      }
      if (url.includes("/td/areas")) {
        return Promise.resolve(jsonResponse({ areas: [] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EditorApp slug="lancaster" />);

    expect(await screen.findByText(/Editing/i)).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: /editor toolbar/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /editor tools/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/properties/i)).toBeInTheDocument());
  });

  it("renders a neutral section and a multi-line station on the Konva canvas (Milestone 53)", async () => {
    // Konva throws on an unknown/invalid prop rather than ignoring it, so actually mounting the
    // stage is the only thing that proves the sign's Group/Rect/Text props are real.
    const doc = draftDoc();
    doc.elements.push(
      {
        id: "ns-1",
        layerId: "layer-default",
        zIndex: 0,
        type: "neutralSection",
        x: 120,
        y: 80,
        size: 20,
        label: "Carnforth NS",
        labelPosition: "below",
        fontSize: 10,
      },
      {
        id: "stn-1",
        layerId: "layer-default",
        zIndex: 0,
        type: "station",
        x: 200,
        y: 40,
        name: "Lancaster\nCastle Junction",
        crs: "LAN",
        fontSize: 16,
      },
    );

    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/draft")) {
        return Promise.resolve(
          jsonResponse({ slug: "lancaster", revision: 1, canonicalDocument: doc }),
        );
      }
      if (url.includes("/td/areas")) {
        return Promise.resolve(jsonResponse({ areas: [] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EditorApp slug="lancaster" />);

    expect(await screen.findByText(/Editing/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/properties/i)).toBeInTheDocument());
    // The palette offers the tool that places one.
    expect(screen.getByRole("button", { name: /neutral sect/i })).toBeInTheDocument();
  });

  it("shows an actionable error when the session expires mid-visit (401)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 401 } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<EditorApp slug="lancaster" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/session has expired/i);
  });
});
