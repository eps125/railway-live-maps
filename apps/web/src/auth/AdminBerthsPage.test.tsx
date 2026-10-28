import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminBerthsPage } from "./AdminBerthsPage.js";
import { PermissionsProvider } from "./permissions.js";

describe("AdminBerthsPage", () => {
  it("links to the Query Berths tool", () => {
    render(
      <PermissionsProvider permissions={new Set(["tools.berth_query"])}>
        <AdminBerthsPage />
      </PermissionsProvider>,
    );
    const heading = screen.getByRole("heading", { name: "Query Berths" });
    expect(heading.closest("a")).toHaveAttribute("href", "/admin/berths/query");
  });

  it("shows only the tools the user's permissions open (Milestone 99)", () => {
    render(
      <PermissionsProvider permissions={new Set(["tools.s_class"])}>
        <AdminBerthsPage />
      </PermissionsProvider>,
    );
    expect(screen.queryByRole("heading", { name: "Query Berths" })).toBeNull();
  });
});
