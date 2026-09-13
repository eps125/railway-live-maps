import { useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import type { SessionUser } from "./useSession.js";

export interface LoginPageProps {
  onLoggedIn: (user: SessionUser) => void;
}

interface LoginErrorBody {
  error?: { message?: string; details?: { retryAfterSeconds?: number } };
}

/** Milestone 29: the deliberately non-obvious `/rlm-login` page — not linked from anywhere in the
 * public app (`App.tsx` only ever navigates here itself, from an unauthenticated `/editor` or
 * `/admin/users` visit). */
export function LoginPage({ onLoggedIn }: LoginPageProps): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        const user = await readApiJson<SessionUser>(response);
        onLoggedIn(user);
        return;
      }
      const body = await readApiJson<LoginErrorBody>(response);
      if (response.status === 429) {
        const retryAfter = body.error?.details?.retryAfterSeconds;
        setError(
          retryAfter
            ? `Too many login attempts — try again in ${Math.ceil(retryAfter / 60)} minute(s).`
            : "Too many login attempts — try again shortly.",
        );
      } else {
        setError(body.error?.message ?? "Invalid username or password.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-form panel-card" onSubmit={(e) => void handleSubmit(e)}>
        <h2>Sign in</h2>
        <label className="field">
          Username
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="login-form__error">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
