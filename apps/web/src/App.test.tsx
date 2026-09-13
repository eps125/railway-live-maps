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
    // Milestone 30: the "Editor" nav link is gone entirely (editing now requires a map slug —
    // reached via a per-map "Edit" link on the landing page), so it's never present at all.
    expect(screen.queryByRole("link", { name: "Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows the Users nav link and a log-out control for a logged-in admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/auth/me")) {
          return Promise.resolve(jsonResponse({ username: "boss", role: "admin" }));
        }
        // The landing page's own `/api/v1/maps` fetch — a 404 renders gracefully as an error
        // message, which is fine here since the nav (this test's actual subject) doesn't depend
        // on it.
        return Promise.resolve({ ok: false, status: 404, text: async () => "" } as Response);
      }),
    );

    render(<App />);

    expect(await screen.findByRole("link", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log out \(boss\)/i })).toBeInTheDocument();
  });

  it("always shows the Maps nav link, pointing at the landing page", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 401 } as Response)),
    );

    render(<App />);

    expect(screen.getByRole("link", { name: "Maps" })).toHaveAttribute("href", "/");
  });
});
