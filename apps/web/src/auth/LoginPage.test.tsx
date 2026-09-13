import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage.js";

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
});

describe("LoginPage", () => {
  it("calls onLoggedIn with the session user on a successful login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ username: "matt", role: "admin" }))),
    );
    const onLoggedIn = vi.fn();

    render(<LoginPage onLoggedIn={onLoggedIn} />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "matt" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(onLoggedIn).toHaveBeenCalledWith({ username: "matt", role: "admin" }),
    );
  });

  it("shows an error message on invalid credentials and does not call onLoggedIn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: { message: "Invalid username or password" } }, 401)),
      ),
    );
    const onLoggedIn = vi.fn();

    render(<LoginPage onLoggedIn={onLoggedIn} />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "matt" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid username or password/i);
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it("shows a friendly message on 429 rate limiting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: { details: { retryAfterSeconds: 120 } } }, 429)),
      ),
    );

    render(<LoginPage onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "matt" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many login attempts/i);
  });
});
