import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  it("renders the app title and the non-safety-critical notice", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Railway Live Maps" })).toBeInTheDocument();
    expect(screen.getByText(/not suitable for safety-critical/i)).toBeInTheDocument();
  });
});
