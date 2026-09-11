import { useState } from "react";
import { readApiJson } from "./apiJson.js";

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
  // Default: apply retroactively to all playback (owner decision 2026-09-11, see
  // docs/IMPLEMENTATION_PLAN.md) — omitting effectiveFrom from the request lets the API apply
  // its own EFFECTIVE_FROM_ALL_TIME default, so this component never needs to know that sentinel
  // value. Un-checking reveals a normal date picker for the rare genuine time-scoped version.
  const [applyToAllHistory, setApplyToAllHistory] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState(() => toDatetimeLocal(new Date()));
  const [publishedBy, setPublishedBy] = useState("");
  const [outcome, setOutcome] = useState<PublishOutcome>({ status: "idle" });

  async function loadDiff(): Promise<void> {
    const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/diff`);
    if (response.ok) {
      setDiff(await readApiJson<DocumentDiff>(response));
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
          effectiveFrom: applyToAllHistory ? undefined : new Date(effectiveFrom).toISOString(),
          publishedBy: publishedBy || undefined,
        }),
      });
      const body = await readApiJson<{
        // `apiError()` shape for handled 4xx…
        error?: {
          message?: string;
          details?: {
            currentRevision?: number;
            errors?: Array<{ code: string; message: string }>;
          };
        };
        // …and Fastify's default shape for an unhandled 500 (`{statusCode,error,message}`).
        message?: string;
        versionNumber?: number;
        effectiveFrom?: string;
      }>(response);
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
          message:
            body.error?.message ?? body.message ?? `Publish failed (HTTP ${response.status})`,
        });
        return;
      }
      setOutcome({
        status: "published",
        versionNumber: body.versionNumber ?? 0,
        effectiveFrom: body.effectiveFrom ?? "",
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
    <section aria-label="Review and publish" className="panel-card">
      <h3>Review</h3>
      <button type="button" className="btn" onClick={() => void loadDiff()}>
        Compare with published version
      </button>
      {diff ? (
        <ul className="diff-summary">
          {diffSummary("Elements", diff.elements)}
          {diffSummary("Bindings", diff.bindings)}
          {diffSummary("Layers", diff.layers)}
        </ul>
      ) : null}

      <fieldset>
        <legend>Publish</legend>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={applyToAllHistory}
            onChange={(e) => setApplyToAllHistory(e.target.checked)}
          />
          Apply to all playback, including history (recommended)
        </label>
        {applyToAllHistory ? null : (
          <label className="field">
            Effective from
            <input
              type="datetime-local"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </label>
        )}
        <label className="field">
          Published by
          <input
            value={publishedBy}
            onChange={(e) => setPublishedBy(e.target.value)}
            placeholder="your name"
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void publish()}
          disabled={outcome.status === "publishing"}
        >
          {outcome.status === "publishing" ? "Publishing…" : "Publish"}
        </button>
      </fieldset>

      {outcome.status === "published" ? (
        <p className="publish-result publish-result--success">
          Published version {outcome.versionNumber}, effective from {outcome.effectiveFrom}.
        </p>
      ) : null}
      {outcome.status === "validationFailed" ? (
        <div role="alert" className="publish-result publish-result--error">
          <p>Cannot publish — validation errors:</p>
          <ul className="issue-list issue-list--errors">
            {outcome.errors.map((err, index) => (
              <li key={`${err.code}-${index}`}>
                <code>{err.code}</code> {err.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {outcome.status === "conflict" ? (
        <p role="alert" className="publish-result publish-result--error">
          The draft changed since you last saved (server is at revision{" "}
          {outcome.currentRevision ?? "?"}) — reload before publishing.
        </p>
      ) : null}
      {outcome.status === "error" ? (
        <p role="alert" className="publish-result publish-result--error">
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}
