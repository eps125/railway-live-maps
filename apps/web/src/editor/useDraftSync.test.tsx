import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider, useEditorDispatch } from "./EditorState.js";
import { gunzipSync } from "node:zlib";
import { Blob as NodeBlob } from "node:buffer";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { GZIP_DRAFT_CONTENT_TYPE, useDraftSync } from "./useDraftSync.js";

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

  it("2026-09-12 regression: setDocument with dirty:true (Toolbar.tsx's JSON import) is queued for autosave", async () => {
    // Previously `setDocument` always set dirty:false, so importing a JSON file visually
    // updated the canvas but this effect (gated on `dirty`) never fired — the import was never
    // actually persisted, and refreshing the page reloaded the server's untouched draft,
    // making the import look like it silently reverted.
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
        type: "setDocument",
        document: { ...baseDoc(), elements: [makeElement("imported-1")] },
        dirty: true,
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/editor/maps/test-slug/draft",
      expect.objectContaining({ method: "PUT" }),
    );
    await waitFor(() => expect(result.current.sync.status).toBe("saved"));
  });

  it("setDocument without dirty (useDraftSync.ts's own reloadFromServer) does NOT trigger a save — it's already what the server has", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
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
      result.current.dispatch({ type: "setDocument", document: baseDoc() });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("2026-09-26 regression: saves slower than the debounce", () => {
    // Owner report: the editor kept saying the server had a different version, sometimes after
    // binding a single signal. The autosave effect depended on `status`, so starting a save
    // re-armed a second 2 s timer with the same expectedRevision; a PUT slower than that (the
    // large Carlisle draft) raced it, and the second PUT hit a 409 against our own first save.
    function slowServer() {
      const pending: Array<(response: Response) => void> = [];
      let revision = 1;
      const fetchMock = vi.fn(
        (_url: string, _init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      );
      return {
        fetchMock,
        /** Completes the oldest outstanding PUT the way the real server would. */
        respond(): void {
          const init = fetchMock.mock.calls[fetchMock.mock.calls.length - pending.length]?.[1];
          const body = JSON.parse(init?.body as string) as { expectedRevision: number };
          const resolve = pending.shift()!;
          if (body.expectedRevision !== revision) {
            resolve(
              jsonResponse(409, {
                error: { code: "DRAFT_REVISION_CONFLICT", details: { currentRevision: revision } },
              }),
            );
            return;
          }
          revision += 1;
          resolve(jsonResponse(200, { revision, canonicalDocument: baseDoc() }));
        },
        outstanding: () => pending.length,
      };
    }

    function renderSync() {
      return renderHook(
        () => {
          const dispatch = useEditorDispatch();
          const sync = useDraftSync("test-slug", 1);
          return { dispatch, sync };
        },
        { wrapper },
      );
    }

    it("never has two saves outstanding, so a slow save can't conflict with itself", async () => {
      vi.useFakeTimers();
      const server = slowServer();
      vi.stubGlobal("fetch", server.fetchMock);
      const { result } = renderSync();

      act(() => {
        result.current.dispatch({
          type: "dispatchCommand",
          command: { type: "addElement", elements: [makeElement("signal-binding")] },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(server.fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        server.respond();
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.sync.status).toBe("saved");
      expect(result.current.sync.syncedRevision).toBe(2);
      expect(server.fetchMock).toHaveBeenCalledTimes(1);
    });

    it("saves an edit made during a slow save afterwards, against the new revision", async () => {
      vi.useFakeTimers();
      const server = slowServer();
      vi.stubGlobal("fetch", server.fetchMock);
      const { result } = renderSync();

      act(() => {
        result.current.dispatch({
          type: "dispatchCommand",
          command: { type: "addElement", elements: [makeElement("first")] },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(server.outstanding()).toBe(1);

      // A second edit while the first save is still on its way.
      act(() => {
        result.current.dispatch({
          type: "dispatchCommand",
          command: { type: "addElement", elements: [makeElement("second")] },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(server.fetchMock).toHaveBeenCalledTimes(1);

      // The first save's response settles (re-arming the timer once React commits), then the
      // debounce runs.
      await act(async () => {
        server.respond();
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // The second edit was not marked saved by the first save; it goes out now, on revision 2.
      expect(server.fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(server.fetchMock.mock.calls[1]![1]!.body as string) as {
        expectedRevision: number;
        canonicalDocument: MapDocument;
      };
      expect(second.expectedRevision).toBe(2);
      expect(second.canonicalDocument.elements.map((e) => e.id)).toEqual(["first", "second"]);

      await act(async () => {
        server.respond();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.sync.status).toBe("saved");
      expect(result.current.sync.syncedRevision).toBe(3);
    });
  });

  describe("2026-09-26: compressed saves", () => {
    // Owner: "saving is taking absolutely ages" — nearly all of a ~3 s Carlisle save was
    // uploading ~300 KB of JSON. The editor now gzips it.
    async function bodyText(init: RequestInit): Promise<string> {
      const body = init.body as Blob | string;
      if (typeof body === "string") return body;
      return gunzipSync(Buffer.from(await body.arrayBuffer())).toString("utf8");
    }

    function withCompression(): void {
      vi.stubGlobal("CompressionStream", NodeCompressionStream);
      vi.stubGlobal("Blob", NodeBlob);
    }

    it("sends the save gzipped, and it decompresses to exactly the plain JSON", async () => {
      vi.useFakeTimers();
      withCompression();
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse(200, { revision: 2, canonicalDocument: baseDoc() })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(
        () => ({ dispatch: useEditorDispatch(), sync: useDraftSync("test-slug", 1) }),
        { wrapper },
      );
      act(() => {
        result.current.dispatch({
          type: "dispatchCommand",
          command: { type: "addElement", elements: [makeElement("gz")] },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const init = fetchMock.mock.calls[0]![1]!;
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        GZIP_DRAFT_CONTENT_TYPE,
      );
      const sent = JSON.parse(await bodyText(init)) as {
        expectedRevision: number;
        canonicalDocument: MapDocument;
      };
      expect(sent.expectedRevision).toBe(1);
      expect(sent.canonicalDocument.elements.map((e) => e.id)).toEqual(["gz"]);
      await vi.waitFor(() => expect(result.current.sync.status).toBe("saved"));
    });

    it("falls back to plain JSON straight away if a compressed save is refused", async () => {
      vi.useFakeTimers();
      withCompression();
      const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          typeof init?.body === "string"
            ? jsonResponse(200, { revision: 2, canonicalDocument: baseDoc() })
            : jsonResponse(415, { error: { code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" } }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(
        () => ({ dispatch: useEditorDispatch(), sync: useDraftSync("test-slug", 1) }),
        { wrapper },
      );
      act(() => {
        result.current.dispatch({
          type: "dispatchCommand",
          command: { type: "addElement", elements: [makeElement("plain")] },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const second = fetchMock.mock.calls[1]![1]!;
      expect((second.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(typeof second.body).toBe("string");
      await vi.waitFor(() => expect(result.current.sync.status).toBe("saved"));
    });
  });
});
