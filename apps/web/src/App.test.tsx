import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("App", () => {
  it("renders the app title and the non-safety-critical notice, logged out", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 401 } as Response)),
    );

    render(<App />);

    expect(screen.getByRole("heading", { name: "Matts TD Map" })).toBeInTheDocument();
    expect(screen.getByText(/not suitable for safety-critical/i)).toBeInTheDocument();
    // Milestone 29: logged out, no editor/admin affordances at all.
    expect(screen.queryByRole("link", { name: "Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows Editor and Users nav links, plus a log-out control, for a logged-in admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/auth/me")) {
          return Promise.resolve(jsonResponse({ username: "boss", role: "admin" }));
        }
        // MapView's own definition/state polling — a 404 renders gracefully as "loading"/error,
        // which is fine here since the nav (this test's actual subject) doesn't depend on it.
        return Promise.resolve({ ok: false, status: 404, text: async () => "" } as Response);
      }),
    );

    render(<App />);

    expect(await screen.findByRole("link", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log out \(boss\)/i })).toBeInTheDocument();
  });
});
