import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUserTypesPage } from "./AdminUserTypesPage.js";
import { PermissionsProvider } from "./permissions.js";

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

const TYPES = {
  types: [
    {
      id: "1",
      systemKey: "public",
      name: "No user (public)",
      description: null,
      sortOrder: 0,
      grantsAll: false,
      permissions: [],
      userCount: 0,
      codeCount: 0,
      codeGrantable: false,
    },
    {
      id: "2",
      systemKey: null,
      name: "Basic User",
      description: null,
      sortOrder: 1,
      grantsAll: false,
      permissions: ["map.playback"],
      userCount: 0,
      codeCount: 6,
      codeGrantable: true,
    },
    {
      id: "6",
      systemKey: "admin",
      name: "Admin",
      description: null,
      sortOrder: 5,
      grantsAll: true,
      permissions: ["map.playback", "admin.users"],
      userCount: 1,
      codeCount: 0,
      codeGrantable: false,
    },
  ],
  permissions: [
    {
      key: "map.playback",
      category: "map",
      label: "Playback",
      description: "Replaying history.",
      codeGrantable: true,
    },
    {
      key: "admin.users",
      category: "admin",
      label: "Users and groups",
      description: "Manage users.",
      codeGrantable: false,
    },
  ],
  categories: [
    { key: "map", label: "Map" },
    { key: "admin", label: "Admin" },
  ],
};

function stub() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/admin/user-types" && !init?.method) {
      return Promise.resolve(jsonResponse(TYPES));
    }
    if (url === "/api/v1/admin/user-types/1" && init?.method === "PATCH") {
      return Promise.resolve(jsonResponse(TYPES.types[0]));
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAs(permissions: string[]) {
  return render(
    <PermissionsProvider permissions={new Set(permissions)}>
      <AdminUserTypesPage />
    </PermissionsProvider>,
  );
}

describe("AdminUserTypesPage (Milestone 99)", () => {
  it("shows the matrix, with Admin always ticked and locked", async () => {
    stub();
    renderAs(["map.playback", "admin.users", "admin.user_types"]);
    const adminUsers = await screen.findByLabelText("Admin: Users and groups");
    expect(adminUsers).toBeChecked();
    expect(adminUsers).toBeDisabled();
    expect(screen.getByLabelText("Basic User: Playback")).toBeChecked();
    expect(screen.getByLabelText("No user (public): Playback")).not.toBeChecked();
  });

  it("saves only the types whose ticks changed", async () => {
    const fetchMock = stub();
    renderAs(["map.playback", "admin.users", "admin.user_types"]);
    fireEvent.click(await screen.findByLabelText("No user (public): Playback"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
      expect(patches).toHaveLength(1);
      expect(patches[0]![0]).toBe("/api/v1/admin/user-types/1");
      expect(JSON.parse((patches[0]![1] as RequestInit).body as string)).toEqual({
        permissions: ["map.playback"],
      });
    });
  });

  it("locks permissions the signed-in user doesn't hold", async () => {
    stub();
    renderAs(["admin.user_types"]);
    expect(await screen.findByLabelText("Basic User: Playback")).toBeDisabled();
  });
});
