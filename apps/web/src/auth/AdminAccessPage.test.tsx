import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAccessPage } from "./AdminAccessPage.js";

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
  vi.restoreAllMocks();
});

const CODE = {
  id: "3",
  label: "Signalling society visit",
  code: "K7QM-3XRP",
  scope: "maps",
  mapIds: ["10"],
  maxUses: 10,
  useCount: 2,
  accessSeconds: 86400,
  validUntil: null,
  notes: null,
  createdBy: "boss",
  createdAt: "2026-10-01T09:00:00Z",
  revokedAt: null,
  activeGrants: 1,
  lastUsedAt: "2026-10-01T10:00:00Z",
  status: "active",
};

const DETAIL = {
  ...CODE,
  flags: ["many_networks"],
  grants: [
    {
      id: "77",
      createdAt: "2026-10-01T10:00:00Z",
      expiresAt: "2099-10-02T10:00:00Z",
      revokedAt: null,
      revokedBy: null,
      firstIp: "203.0.113.9",
      firstUserAgent: "Firefox",
      lastSeenAt: "2026-10-01T11:00:00Z",
      lastIp: "198.51.100.4",
      distinctIps: 3,
      requestCount: 120,
      flags: ["many_ips", "simultaneous_ips"],
      activity: [
        {
          hour: "2026-10-01T11:00:00Z",
          ip: "198.51.100.4",
          userAgent: "Firefox",
          requestCount: 60,
        },
      ],
    },
  ],
};

function stub(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handled = extra?.(url, init);
    if (handled) return Promise.resolve(handled);
    if (url === "/api/v1/admin/settings" && !init?.method) {
      return Promise.resolve(jsonResponse({ settings: { site_access_mode: "open" } }));
    }
    if (url === "/api/v1/admin/access-codes" && !init?.method) {
      return Promise.resolve(jsonResponse({ codes: [CODE] }));
    }
    if (url === "/api/v1/editor/maps") {
      return Promise.resolve(
        jsonResponse({ maps: [{ id: "10", slug: "lancaster", name: "Lancaster" }] }),
      );
    }
    if (url === "/api/v1/admin/access-codes/3") return Promise.resolve(jsonResponse(DETAIL));
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof stub>, url: string, method: string): unknown {
  const call = fetchMock.mock.calls.find(([u, init]) => u === url && init?.method === method);
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

describe("AdminAccessPage", () => {
  it("lists codes with what they give, uses and how long a use lasts", async () => {
    stub();
    render(<AdminAccessPage />);
    expect(await screen.findByText("K7QM-3XRP")).toBeInTheDocument();
    expect(screen.getByText("Only: Lancaster")).toBeInTheDocument();
    expect(screen.getByText("2 of 10")).toBeInTheDocument();
    expect(screen.getByText("1 day")).toBeInTheDocument();
  });

  it("asks before requiring a code, then switches the site", async () => {
    const fetchMock = stub((url, init) =>
      url === "/api/v1/admin/settings" && init?.method === "PATCH"
        ? jsonResponse({ settings: { site_access_mode: "code_required" } })
        : undefined,
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminAccessPage />);
    fireEvent.click(await screen.findByLabelText(/access code required/i));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/api/v1/admin/settings", "PATCH")).toEqual({
        site_access_mode: "code_required",
      }),
    );
  });

  it("creates a custom, limited, maps-only code", async () => {
    const fetchMock = stub((url, init) =>
      url === "/api/v1/admin/access-codes" && init?.method === "POST"
        ? jsonResponse(CODE, 201)
        : undefined,
    );
    const { container } = render(<AdminAccessPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New access code" }));
    const form = within(container.querySelector<HTMLElement>(".access-code-form")!);

    fireEvent.change(form.getByLabelText(/label/i), { target: { value: "Open day" } });
    fireEvent.click(form.getByLabelText("Choose my own"));
    fireEvent.change(form.getByLabelText(/your code/i), { target: { value: "OPENDAY26" } });
    fireEvent.click(form.getByLabelText(/only these maps/i));
    fireEvent.click(form.getByLabelText("Lancaster"));
    fireEvent.click(form.getByLabelText(/limited to/i));
    fireEvent.change(form.getByLabelText("Maximum uses"), { target: { value: "50" } });
    fireEvent.change(form.getByLabelText(/each use gives access for/i), {
      target: { value: "14400" },
    });
    fireEvent.click(form.getByRole("button", { name: "Create code" }));

    await waitFor(() =>
      expect(bodyOf(fetchMock, "/api/v1/admin/access-codes", "POST")).toEqual({
        label: "Open day",
        code: "OPENDAY26",
        scope: "maps",
        mapIds: ["10"],
        maxUses: 50,
        accessSeconds: 14400,
        validUntil: null,
        notes: null,
      }),
    );
  });

  it("shows a code's uses with sharing flags, and changes or ends one use", async () => {
    const fetchMock = stub((url, init) => {
      if (url === "/api/v1/admin/access-grants/77" && init?.method === "PATCH") {
        return jsonResponse({ id: "77" });
      }
      if (url === "/api/v1/admin/access-grants/77/revoke") return jsonResponse({ id: "77" });
      return undefined;
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminAccessPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Uses and activity" }));

    expect(await screen.findByText(/3 or more different networks/i)).toBeInTheDocument();
    expect(screen.getByText("203.0.113.9")).toBeInTheDocument();
    expect(screen.getByTitle(/3 or more addresses; .*same hour/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change end" }));
    fireEvent.change(screen.getByLabelText("Access until"), {
      target: { value: "2031-01-01T12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/api/v1/admin/access-grants/77", "PATCH")).toEqual({
        expiresAt: new Date("2031-01-01T12:00").toISOString(),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "End now" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/api/v1/admin/access-grants/77/revoke"),
      ).toBe(true),
    );
  });

  it("revokes a code after confirming", async () => {
    const fetchMock = stub((url) =>
      url === "/api/v1/admin/access-codes/3/revoke"
        ? jsonResponse({ ...CODE, status: "revoked" })
        : undefined,
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminAccessPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/api/v1/admin/access-codes/3/revoke"),
      ).toBe(true),
    );
  });
});
