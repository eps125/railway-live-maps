import { useEffect, useState } from "react";
import type { MapDocument } from "@railway/map-schema";
import { EditorStateProvider } from "./EditorState.js";
import { EditorWorkspace } from "./EditorWorkspace.js";

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
 * panels). A 404 here almost always means `EDITOR_ENABLED=false` on the API. */
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
            response.status === 404
              ? "Editor is not enabled on this deployment (EDITOR_ENABLED=false)."
              : `Failed to load draft (${response.status})`,
          );
        }
        const body = (await response.json()) as DraftResponse;
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
