import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapBinding } from "@railway/map-schema";
import { useLiveSignalStates } from "./useLiveSignalStates.js";

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
});
