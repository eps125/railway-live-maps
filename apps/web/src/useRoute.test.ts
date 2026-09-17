import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { navigate, useRoute } from "./useRoute.js";

function setPath(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

describe("useRoute", () => {
  afterEach(() => {
    setPath("/");
  });

  it("parses the landing page", () => {
    setPath("/");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "landing" });
  });

  it("parses /map/:slug", () => {
    setPath("/map/lancaster");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "map", slug: "lancaster" });
  });

  it("parses /editor/:slug", () => {
    setPath("/editor/lancaster");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "editor", slug: "lancaster" });
  });

  it("treats a bare /editor (no slug) as the editor picker", () => {
    setPath("/editor");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "editorPicker" });
  });

  it("parses /rlm-login and /admin/users", () => {
    setPath("/rlm-login");
    expect(renderHook(() => useRoute()).result.current).toEqual({ name: "login" });

    setPath("/admin/users");
    expect(renderHook(() => useRoute()).result.current).toEqual({ name: "adminUsers" });
  });

  it("parses /admin/berths and /admin/berths/query", () => {
    setPath("/admin/berths");
    expect(renderHook(() => useRoute()).result.current).toEqual({ name: "adminBerths" });

    setPath("/admin/berths/query");
    expect(renderHook(() => useRoute()).result.current).toEqual({ name: "adminBerthQuery" });
  });

  it("decodes an encoded slug", () => {
    setPath("/map/a%20b");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "map", slug: "a b" });
  });

  it("navigate() pushes history state and updates the hook without a full reload", () => {
    setPath("/");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "landing" });

    act(() => navigate("/map/lancaster"));
    expect(result.current).toEqual({ name: "map", slug: "lancaster" });
  });
});
