import { useEffect, useRef, useState } from "react";
import type { MapDocument } from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";

const AUTOSAVE_DEBOUNCE_MS = 2000;

export type DraftSyncStatus = "idle" | "saving" | "saved" | "conflict" | "error";

export interface UseDraftSyncResult {
  status: DraftSyncStatus;
  /** The last revision this client knows the server has — what `ReviewPanel`'s publish call
   * sends as its own `expectedRevision`, so a publish never targets a revision that's already
   * stale locally. */
  syncedRevision: number;
  /** Only meaningful when `status === "conflict"` — what the server says the current
   * revision actually is. */
  conflictRevision: number | null;
  /** Discards local unsaved changes and reloads the draft from the server — the recovery
   * path out of a conflict. */
  reloadFromServer: () => void;
}

interface DraftResponse {
  revision: number;
  canonicalDocument: MapDocument;
}

/** docs/MAP_EDITOR_SPEC.md §7: "Autosave draft without publishing." Debounces on document
 * changes, PUTs with the optimistic-lock `expectedRevision` (docs/API_CONTRACT.md §4), and
 * surfaces a `409` conflict as a distinct state — "someone/something changed this draft" —
 * rather than silently overwriting the server's newer revision. */
export function useDraftSync(slug: string, initialRevision: number): UseDraftSyncResult {
  const { document: doc, dirty } = useEditorState();
  const dispatch = useEditorDispatch();
  const revisionRef = useRef(initialRevision);
  const [status, setStatus] = useState<DraftSyncStatus>("idle");
  const [syncedRevision, setSyncedRevision] = useState(initialRevision);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);

  useEffect(() => {
    if (!dirty || status === "conflict") return;

    const timer = setTimeout(() => {
      setStatus("saving");
      fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalDocument: doc, expectedRevision: revisionRef.current }),
      })
        .then(async (response) => {
          if (response.status === 409) {
            const body = (await response.json()) as {
              error: { details?: { currentRevision?: number } };
            };
            setConflictRevision(body.error.details?.currentRevision ?? null);
            setStatus("conflict");
            return;
          }
          if (!response.ok) {
            setStatus("error");
            return;
          }
          const body = (await response.json()) as DraftResponse;
          revisionRef.current = body.revision;
          setSyncedRevision(body.revision);
          dispatch({ type: "markSynced" });
          setStatus("saved");
        })
        .catch(() => setStatus("error"));
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [doc, dirty, slug, dispatch, status]);

  function reloadFromServer(): void {
    fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/draft`)
      .then((response) => (response.ok ? (response.json() as Promise<DraftResponse>) : null))
      .then((body) => {
        if (!body) return;
        revisionRef.current = body.revision;
        setSyncedRevision(body.revision);
        dispatch({ type: "setDocument", document: body.canonicalDocument });
        setStatus("idle");
        setConflictRevision(null);
      })
      .catch(() => setStatus("error"));
  }

  return { status, syncedRevision, conflictRevision, reloadFromServer };
}
