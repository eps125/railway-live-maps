import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { AccessCodePage } from "./AccessCodePage.js";
import { formatDuration, fromDateTimeLocal, toDateTimeLocal } from "./accessCodeFormat.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

const CLOSED = {
  mode: "code_required",
  access: "none",
  allowed: false,
  expiresAt: null,
  scope: null,
  maps: [],
};
const WITH_CODE = {
  mode: "code_required",
  access: "code",
  allowed: true,
  expiresAt: "2030-01-01T18:30:00Z",
  scope: "site",
  maps: [],
};

describe("AccessCodePage", () => {
  it("sends the code and reports acceptance", async () => {
    const onAccepted = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(WITH_CODE)));
    vi.stubGlobal("fetch", fetchMock);

    render(<AccessCodePage onAccepted={onAccepted} />);
    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "k7qm-3xrp" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/access/redeem",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "k7qm-3xrp" }) }),
    );
  });

  it("shows why a code was refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: { message: "That code has expired." } }, 401)),
      ),
    );
    render(<AccessCodePage onAccepted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "OLD1" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code has expired.");
  });
});

describe("App with an access code required", () => {
  it("shows the code page at any address, keeps the address, then shows the page asked for", async () => {
    window.history.pushState(null, "", "/map/lancaster?at=2026-09-30T12:00:00Z");
    let status: unknown = CLOSED;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/v1/auth/me") return Promise.resolve(jsonResponse({}, 401));
        if (url === "/api/v1/access/status") return Promise.resolve(jsonResponse(status));
        if (url === "/api/v1/access/redeem") {
          status = WITH_CODE;
          return Promise.resolve(jsonResponse(WITH_CODE));
        }
        // The map page's own requests: not this test's subject.
        return Promise.resolve(jsonResponse({ error: { message: "nope" } }, 404));
      }),
    );

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Got a code?" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Maps" })).not.toBeInTheDocument();
    // Owner request: no login link on the code page.
    expect(screen.queryByRole("link", { name: /login/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "K7QM3XRP" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Got a code?" })).not.toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe("/map/lancaster");
    expect(window.location.search).toContain("at=");
    expect(await screen.findByText(/access until/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget code" })).toBeInTheDocument();
  });

  it("never shows the code page on an open site", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/v1/access/status") {
          return Promise.resolve(jsonResponse({ ...CLOSED, mode: "open", allowed: true }));
        }
        if (url === "/api/v1/maps") return Promise.resolve(jsonResponse({ maps: [] }));
        return Promise.resolve(jsonResponse({}, 401));
      }),
    );
    render(<App />);
    expect(await screen.findByText("No maps published yet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Got a code?" })).toBeNull();
  });
});

describe("access code formatting", () => {
  it("describes a duration in at most two units", () => {
    expect(formatDuration(3600)).toBe("1 hour");
    expect(formatDuration(7 * 86400)).toBe("7 days");
    expect(formatDuration(90000)).toBe("1 day 1 hour");
    expect(formatDuration(5400)).toBe("1 hour 30 minutes");
    expect(formatDuration(30)).toBe("under a minute");
  });

  it("round-trips a datetime-local value", () => {
    const iso = "2030-06-01T09:15:00.000Z";
    expect(fromDateTimeLocal(toDateTimeLocal(iso))).toBe(iso);
    expect(fromDateTimeLocal("")).toBeNull();
  });
});
