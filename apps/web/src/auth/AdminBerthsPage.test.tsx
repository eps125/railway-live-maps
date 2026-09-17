import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminBerthsPage } from "./AdminBerthsPage.js";

describe("AdminBerthsPage", () => {
  it("links to the Query Berths tool", () => {
    render(<AdminBerthsPage />);
    expect(screen.getByRole("link", { name: "Query Berths" })).toHaveAttribute(
      "href",
      "/admin/berths/query",
    );
  });
});
