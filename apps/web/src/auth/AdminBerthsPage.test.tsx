import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminBerthsPage } from "./AdminBerthsPage.js";

describe("AdminBerthsPage", () => {
  it("links to the Query Berths tool", () => {
    render(<AdminBerthsPage />);
    const heading = screen.getByRole("heading", { name: "Query Berths" });
    expect(heading.closest("a")).toHaveAttribute("href", "/admin/berths/query");
  });
});
