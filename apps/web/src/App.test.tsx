import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(screen.getByRole("heading", { name: "Matts TD Mapping Project" })).toBeInTheDocument();
    expect(screen.getByText(/not suitable for safety-critical/i)).toBeInTheDocument();
    // Milestone 30: the "Editor" nav link is gone entirely (editing now requires a map slug —
    // reached via a per-map "Edit" link on the landing page), so it's never present at all.
    expect(screen.queryByRole("link", { name: "Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("shows the Admin nav link and a log-out control for a logged-in admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/auth/me")) {
          return Promise.resolve(
            jsonResponse({
              username: "boss",
              userType: { id: "6", name: "Admin" },
              permissions: ["site.view", "maps.view_public", "admin.users", "editor.view"],
            }),
          );
        }
        // The landing page's own `/api/v1/maps` fetch — a 404 renders gracefully as an error
        // message, which is fine here since the nav (this test's actual subject) doesn't depend
        // on it.
        return Promise.resolve({ ok: false, status: 404, text: async () => "" } as Response);
      }),
    );

    render(<App />);

    // Milestone 83: one "Admin" link to the admin hub, so the header fits a phone.
    expect(await screen.findByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
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

  describe("light mode (2026-10-29)", () => {
    function stubAs(permissions: string[]) {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.includes("/auth/me")) {
            return Promise.resolve(
              jsonResponse({
                username: "ann",
                userType: { id: "2", name: "Basic User" },
                permissions,
              }),
            );
          }
          return Promise.resolve({ ok: false, status: 404, text: async () => "" } as Response);
        }),
      );
    }

    afterEach(() => {
      window.localStorage.removeItem("rlm.theme");
      delete document.documentElement.dataset.theme;
    });

    it("offers the switch with site.light_mode, applies it and remembers it", async () => {
      stubAs(["site.view", "site.light_mode"]);
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Switch to light mode" }));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(window.localStorage.getItem("rlm.theme")).toBe("light");
      fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
      expect(document.documentElement.dataset.theme).toBeUndefined();
      expect(window.localStorage.getItem("rlm.theme")).toBe("dark");
    });

    it("stays dark, with no switch, without the permission — even if light was remembered", async () => {
      window.localStorage.setItem("rlm.theme", "light");
      document.documentElement.dataset.theme = "light";
      stubAs(["site.view"]);
      render(<App />);
      await screen.findByRole("button", { name: /log out/i });
      await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
      expect(screen.queryByRole("button", { name: /switch to/i })).toBeNull();
    });
  });
});
