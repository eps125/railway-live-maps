import { useEffect, useRef, useState } from "react";
import type { MapDocument } from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";

const AUTOSAVE_DEBOUNCE_MS = 2000;
/** After a failed save (network or server error), wait longer before trying again. */
const AUTOSAVE_RETRY_MS = 10_000;

/** Matches the API's `GZIP_DRAFT_CONTENT_TYPE` (apps/api/src/routes/editor/drafts.ts). */
export const GZIP_DRAFT_CONTENT_TYPE = "application/x-rlm-draft-gzip";

/** 2026-09-26 (owner: "saving is taking absolutely ages"): nearly all of a ~3 s Carlisle save was
 * uploading ~300 KB of JSON, which gzips about tenfold. Returns the gzipped bytes, or null where
 * the browser can't compress (the caller then sends plain JSON). */
export async function gzipDraftBody(json: string): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch {
    return null;
  }
}

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
  // 2026-09-26 (owner: "server has a different version" after binding one signal): saves are
  // strictly one at a time. `status` used to be an effect dependency, so starting a save re-armed
  // a second timer carrying the same expectedRevision, and a PUT slower than the debounce (the
  // large Carlisle draft) raced it into a 409 against our own first save.
  const docRef = useRef(doc);
  docRef.current = doc;
  const inFlight = useRef(false);
  const conflicted = useRef(false);
  const lastFailed = useRef(false);
  const gzipAllowed = useRef(true);
  const retryNow = useRef(false);
  /** Bumped when a finished save leaves newer edits (or a failure) to save — re-arms the timer. */
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!dirty || conflicted.current) return;
    const delay = retryNow.current
      ? 0
      : lastFailed.current
        ? AUTOSAVE_RETRY_MS
        : AUTOSAVE_DEBOUNCE_MS;
    retryNow.current = false;
    const timer = setTimeout(() => void save(), delay);
    return () => clearTimeout(timer);
  }, [doc, dirty, slug, retry]);

  async function save(): Promise<void> {
    // A save already on its way: when it returns it re-arms the timer for anything newer.
    if (inFlight.current || conflicted.current) return;
    const sent = docRef.current;
    inFlight.current = true;
    setStatus("saving");
    let settled = false;
    try {
      const json = JSON.stringify({
        canonicalDocument: sent,
        expectedRevision: revisionRef.current,
      });
      const gzipped = gzipAllowed.current ? await gzipDraftBody(json) : null;
      const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/draft`, {
        method: "PUT",
        headers: { "Content-Type": gzipped ? GZIP_DRAFT_CONTENT_TYPE : "application/json" },
        body: gzipped ?? json,
      });
      if (gzipped && (response.status === 400 || response.status === 415)) {
        // Something between here and the API (or the API) wouldn't take the compressed upload:
        // send plain JSON from now on, straight away.
        gzipAllowed.current = false;
        retryNow.current = true;
        return;
      }
      if (response.status === 409) {
        const body = (await response.json()) as {
          error: { details?: { currentRevision?: number } };
        };
        conflicted.current = true;
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
      // Clean only if nothing changed since this document was sent; a newer edit stays dirty and
      // is saved next, against the revision just returned.
      dispatch({ type: "markSynced", document: sent });
      settled = sent === docRef.current;
      setStatus(settled ? "saved" : "saving");
    } catch {
      setStatus("error");
    } finally {
      inFlight.current = false;
      lastFailed.current =
        !settled && !conflicted.current && !retryNow.current && sent === docRef.current;
      if (!settled && !conflicted.current) setRetry((n) => n + 1);
    }
  }

  function reloadFromServer(): void {
    fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/draft`)
      .then((response) => (response.ok ? (response.json() as Promise<DraftResponse>) : null))
      .then((body) => {
        if (!body) return;
        conflicted.current = false;
        lastFailed.current = false;
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
