import { useEffect, useState } from "react";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider } from "./EditorState.js";
import { EditorWorkspace } from "./EditorWorkspace.js";
import { readApiJson } from "./apiJson.js";

export interface EditorAppProps {
  slug: string;
}

interface DraftResponse {
  slug: string;
  revision: number;
  canonicalDocument: MapDocument;
}

/** Milestone 11/12 top-level editor page: loads the current draft, then hands it to
 * `EditorStateProvider` (the undo/redo command-model state) and `EditorWorkspace` (canvas +
 * panels). `App.tsx` already redirects an unauthenticated/under-privileged visit to `/rlm-login`
 * before this ever mounts (Milestone 29), so a 401/403 here would mean the session expired
 * mid-visit rather than a normal first-load case. */
export function EditorApp({ slug }: EditorAppProps): JSX.Element {
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/draft`);
        if (!response.ok) {
          throw new Error(
            response.status === 401 || response.status === 403
              ? "Your session has expired — reload the page to log in again."
              : `Failed to load draft (${response.status})`,
          );
        }
        const body = await readApiJson<DraftResponse>(response);
        if (!cancelled) setDraft(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load draft");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <p role="alert" className="app-error">
        {error}
      </p>
    );
  }
  if (!draft) {
    return <p className="app-loading">Loading editor…</p>;
  }

  return (
    <EditorStateProvider initialDocument={draft.canonicalDocument}>
      <EditorWorkspace slug={slug} initialRevision={draft.revision} />
    </EditorStateProvider>
  );
}
