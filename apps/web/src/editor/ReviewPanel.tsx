import { useState } from "react";

interface IdDiff {
  added: string[];
  removed: string[];
  modified: string[];
}
interface DocumentDiff {
  elements: IdDiff;
  bindings: IdDiff;
  layers: IdDiff;
}

export type PublishOutcome =
  | { status: "idle" }
  | { status: "publishing" }
  | { status: "published"; versionNumber: number; effectiveFrom: string }
  | { status: "validationFailed"; errors: Array<{ code: string; message: string }> }
  | { status: "conflict"; currentRevision: number | null }
  | { status: "error"; message: string };

export interface ReviewPanelProps {
  slug: string;
  syncedRevision: number;
  onPublished: () => void;
}

function toDatetimeLocal(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** docs/MAP_EDITOR_SPEC.md §11: Review mode — "compare and publish." Diff defaults to "current
 * draft vs currently published version" (both `fromVersion`/`toRevision` query params omitted,
 * per `apps/api/src/routes/editor/diff.ts`'s own documented default), and publish sends the
 * `expectedRevision` the draft-sync hook last confirmed the server has — never a stale one. */
export function ReviewPanel({ slug, syncedRevision, onPublished }: ReviewPanelProps): JSX.Element {
  const [diff, setDiff] = useState<DocumentDiff | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(() => toDatetimeLocal(new Date()));
  const [publishedBy, setPublishedBy] = useState("");
  const [outcome, setOutcome] = useState<PublishOutcome>({ status: "idle" });

  async function loadDiff(): Promise<void> {
    const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/diff`);
    if (response.ok) {
      setDiff((await response.json()) as DocumentDiff);
    }
  }

  async function publish(): Promise<void> {
    setOutcome({ status: "publishing" });
    try {
      const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: syncedRevision,
          effectiveFrom: new Date(effectiveFrom).toISOString(),
          publishedBy: publishedBy || undefined,
        }),
      });
      const body = await response.json();
      if (response.status === 409) {
        setOutcome({
          status: "conflict",
          currentRevision: body.error?.details?.currentRevision ?? null,
        });
        return;
      }
      if (response.status === 422) {
        setOutcome({ status: "validationFailed", errors: body.error?.details?.errors ?? [] });
        return;
      }
      if (!response.ok) {
        setOutcome({
          status: "error",
          message: body.error?.message ?? `Publish failed (${response.status})`,
        });
        return;
      }
      setOutcome({
        status: "published",
        versionNumber: body.versionNumber,
        effectiveFrom: body.effectiveFrom,
      });
      onPublished();
    } catch (error) {
      setOutcome({
        status: "error",
        message: error instanceof Error ? error.message : "Publish failed",
      });
    }
  }

  function diffSummary(label: string, idDiff: IdDiff): JSX.Element {
    return (
      <li>
        {label}: {idDiff.added.length} added, {idDiff.removed.length} removed,{" "}
        {idDiff.modified.length} modified
      </li>
    );
  }

  return (
    <section aria-label="Review and publish">
      <h3>Review</h3>
      <button type="button" onClick={() => void loadDiff()}>
        Compare with published version
      </button>
      {diff ? (
        <ul>
          {diffSummary("Elements", diff.elements)}
          {diffSummary("Bindings", diff.bindings)}
          {diffSummary("Layers", diff.layers)}
        </ul>
      ) : null}

      <fieldset>
        <legend>Publish</legend>
        <label>
          Effective from
          <input
            type="datetime-local"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </label>
        <label>
          Published by
          <input
            value={publishedBy}
            onChange={(e) => setPublishedBy(e.target.value)}
            placeholder="your name"
          />
        </label>
        <button
          type="button"
          onClick={() => void publish()}
          disabled={outcome.status === "publishing"}
        >
          {outcome.status === "publishing" ? "Publishing…" : "Publish"}
        </button>
      </fieldset>

      {outcome.status === "published" ? (
        <p>
          Published version {outcome.versionNumber}, effective from {outcome.effectiveFrom}.
        </p>
      ) : null}
      {outcome.status === "validationFailed" ? (
        <div role="alert">
          <p>Cannot publish — validation errors:</p>
          <ul>
            {outcome.errors.map((err, index) => (
              <li key={`${err.code}-${index}`}>
                [{err.code}] {err.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {outcome.status === "conflict" ? (
        <p role="alert">
          The draft changed since you last saved (server is at revision{" "}
          {outcome.currentRevision ?? "?"}) — reload before publishing.
        </p>
      ) : null}
      {outcome.status === "error" ? <p role="alert">{outcome.message}</p> : null}
    </section>
  );
}
