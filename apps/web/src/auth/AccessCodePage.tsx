import { useState } from "react";
import { readApiJson } from "../editor/apiJson.js";

interface ErrorBody {
  error?: { message?: string };
}

export interface AccessCodePageProps {
  /** Called after a code is accepted; the page the visitor asked for then shows. */
  onAccepted: () => void;
}

/**
 * Milestone 84 (docs/adr/0018 §6): shown at every address while the site needs an access code
 * and this visitor has none. The address is left alone, so once a code is accepted the visitor
 * sees the page they asked for (a shared map or playback link still works).
 */
export function AccessCodePage({ onAccepted }: AccessCodePageProps): JSX.Element {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/access/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        const body = await readApiJson<ErrorBody>(response);
        setError(body.error?.message ?? "That code didn't work.");
        return;
      }
      onAccepted();
    } catch {
      setError("Couldn't check the code. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="access-code-page">
      <form className="access-code-page__form" onSubmit={(e) => void submit(e)}>
        <h2>Got a code?</h2>
        <p>
          The maps are only open to people with an access code at the moment. If you&apos;ve been
          given one, type it in below.
        </p>
        <div className="access-code-page__entry">
          <input
            type="text"
            aria-label="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            required
            autoFocus
          />
          <button type="submit" className="btn btn--primary" disabled={submitting || !code.trim()}>
            {submitting ? "Checking…" : "Go"}
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
