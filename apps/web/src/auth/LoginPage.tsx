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

  // Owner request 2026-10-01: the same card as the access code page, with the boxes drawn like
  // a train describer berth.
  return (
    <div className="access-code-page">
      <form className="access-code-page__form" onSubmit={(e) => void handleSubmit(e)}>
        <h2>Signing in?</h2>
        <p>This login is for authorised users to access the Live Map backend.</p>
        <label className="login-card__field">
          Username
          <input
            type="text"
            className="berth-input"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className="login-card__field">
          Password
          <input
            type="password"
            className="berth-input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="login-card__actions">
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {error && (
          <p role="alert" className="access-code-page__error">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
