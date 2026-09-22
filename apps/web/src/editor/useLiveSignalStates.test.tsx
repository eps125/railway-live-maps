import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapBinding } from "@railway/map-schema";
import { useLiveSClassStates, useLiveSignalStates } from "./useLiveSignalStates.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const sBit: MapBinding = {
  id: "b1",
  elementId: "sig-1",
  type: "tdSBit",
  tdArea: "M9",
  address: "03",
  bit: 2,
  activeMeans: "off",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLiveSignalStates (Milestone 36c)", () => {
  it("polls the draft's live state and keeps only bound signals", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          signals: { "sig-1": { state: "on" }, "sig-unbound": { state: "blank" } },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLiveSignalStates("blackpool", { bindings: [sBit] }));

    await waitFor(() => expect(result.current).toEqual({ "sig-1": "on" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/editor/state/blackpool");
  });

  it("does not poll at all when the draft has no signal bindings", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveSignalStates("blackpool", { bindings: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });

  it("returns bound routes' live state from the same poll (Milestone 64)", async () => {
    const routeBit: MapBinding = {
      id: "b2",
      elementId: "route-1",
      type: "tdSBitRoute",
      tdArea: "M9",
      address: "0C",
      bit: 4,
      activeMeans: "set",
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          signals: { "sig-1": { state: "off" } },
          routes: { "route-1": { state: "set" }, "route-unbound": { state: "blank" } },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useLiveSClassStates("blackpool", { bindings: [sBit, routeBit] }),
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        signals: { "sig-1": "off" },
        routes: { "route-1": "set" },
      }),
    );
  });
});
