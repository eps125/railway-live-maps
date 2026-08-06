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
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
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

  it("shows an actionable error when the editor API 404s (EDITOR_ENABLED=false)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<EditorApp slug="lancaster" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/EDITOR_ENABLED/i);
  });
});
