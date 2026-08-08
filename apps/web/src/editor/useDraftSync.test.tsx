import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider, useEditorDispatch } from "./EditorState.js";
import { useDraftSync } from "./useDraftSync.js";

function baseDoc(): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "m",
      name: "m",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l", name: "l", visible: true, locked: false, order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <EditorStateProvider initialDocument={baseDoc()}>{children}</EditorStateProvider>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeElement(id: string) {
  return {
    id,
    layerId: "l",
    zIndex: 0,
    type: "label" as const,
    x: 0,
    y: 0,
    text: id,
    align: "left" as const,
    fontSize: 12,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useDraftSync", () => {
  it("debounces and PUTs the document with the tracked expectedRevision, then marks synced", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { revision: 2, canonicalDocument: baseDoc() })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => {
        const dispatch = useEditorDispatch();
        const sync = useDraftSync("test-slug", 1);
        return { dispatch, sync };
      },
      { wrapper },
    );

    act(() => {
      result.current.dispatch({
        type: "dispatchCommand",
        command: { type: "addElement", elements: [makeElement("new-1")] },
      });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/editor/maps/test-slug/draft",
      expect.objectContaining({ method: "PUT" }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = JSON.parse(requestInit?.body as string);
    expect(requestBody.expectedRevision).toBe(1);

    await waitFor(() => expect(result.current.sync.status).toBe("saved"));
    expect(result.current.sync.syncedRevision).toBe(2);
  });

  it("surfaces a 409 as a conflict state without silently overwriting", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(409, {
          error: { code: "DRAFT_REVISION_CONFLICT", details: { currentRevision: 5 } },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => {
        const dispatch = useEditorDispatch();
        const sync = useDraftSync("test-slug", 1);
        return { dispatch, sync };
      },
      { wrapper },
    );

    act(() => {
      result.current.dispatch({
        type: "dispatchCommand",
        command: { type: "addElement", elements: [makeElement("new-1")] },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await waitFor(() => expect(result.current.sync.status).toBe("conflict"));
    expect(result.current.sync.conflictRevision).toBe(5);
    // The client's own tracked revision must NOT have been silently bumped to the server's.
    expect(result.current.sync.syncedRevision).toBe(1);
  });
});
