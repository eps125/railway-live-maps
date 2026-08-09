import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider } from "./EditorState.js";
import { useTestModePanel } from "./TestModePanel.js";

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
    ],
    topology: { nodes: [], edges: [] },
    bindings: [
      {
        id: "bind-a",
        elementId: "berth-a",
        type: "tdBerth",
        tdArea: "PX",
        berth: "0512",
        allowDuplicate: false,
      },
    ],
    editorMetadata: {},
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Mounts just the panel this hook returns — same pattern EditorApp uses to embed it, minus
 * the rest of the editor chrome this test doesn't need. */
function Harness({ slug }: { slug: string }): JSX.Element {
  const { panel } = useTestModePanel(slug);
  return panel;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TestModePanel live mode — clear berth", () => {
  it("clears an occupied berth via the API and refreshes the list", async () => {
    let cleared = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/clear") && init?.method === "POST") {
        cleared = true;
        expect(JSON.parse(init.body as string)).toEqual({ reason: "stuck after a feed gap" });
        return Promise.resolve(jsonResponse({ tdArea: "PX", berth: "0512", cleared: true }));
      }
      if (url.includes("/api/v1/editor/state/")) {
        return Promise.resolve(
          jsonResponse({
            berths: { "berth-a": { description: cleared ? null : "1A23" } },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <EditorStateProvider initialDocument={baseDoc()}>
        <Harness slug="lancaster" />
      </EditorStateProvider>,
    );

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "live" } });

    expect(await screen.findByText(/1A23/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.change(screen.getByPlaceholderText("Reason (required)"), {
      target: { value: "stuck after a feed gap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));

    await waitFor(() => expect(cleared).toBe(true));
    await waitFor(() => expect(screen.queryByText(/1A23/)).not.toBeInTheDocument());
  });

  it("shows an error and does not call the API when no reason is given", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/v1/editor/state/")) {
        return Promise.resolve(jsonResponse({ berths: { "berth-a": { description: "1A23" } } }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <EditorStateProvider initialDocument={baseDoc()}>
        <Harness slug="lancaster" />
      </EditorStateProvider>,
    );

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "live" } });
    expect(await screen.findByText(/1A23/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A reason is required");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/clear"))).toBe(false);
  });
});
