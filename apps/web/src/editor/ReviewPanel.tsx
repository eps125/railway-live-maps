import { useEffect, useState } from "react";
import { readApiJson } from "./apiJson.js";
import { useCan } from "../auth/permissions.js";

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
  | {
      status: "published";
      versionNumber: number;
      effectiveFrom: string;
      /** Milestone 85: after a module publish, every map assembled from it was republished. */
      kind: "map" | "module";
      cascade: CascadeOutcome[];
      /** Milestone 96: modules published together with the map. */
      modules: Array<{ slug: string; versionNumber: number }>;
    }
  | { status: "validationFailed"; errors: Array<{ code: string; message: string }> }
  | { status: "conflict"; currentRevision: number | null }
  | { status: "error"; message: string };

/** Milestone 96: one of an assembled map's modules, as `GET .../module-changes` reports it. */
export interface ModuleChange {
  slug: string;
  name: string | null;
  status: "changed" | "never_published" | "unchanged" | "missing";
  draftRevision: number | null;
  publishedVersion: number | null;
}

/** Milestone 96: what to do with modules that have unpublished drafts. */
export type ModulePublishChoice = "withModules" | "mapOnly";

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
/** Milestone 85: one map republished after a module publish. */
interface CascadeOutcome {
  slug: string;
  ok: boolean;
  versionNumber?: number;
  errors?: Array<{ code: string; message: string }>;
}

export function ReviewPanel({ slug, syncedRevision, onPublished }: ReviewPanelProps): JSX.Element {
  const canPublish = useCan()("maps.publish");
  const [diff, setDiff] = useState<DocumentDiff | null>(null);
  // Default: apply retroactively to all playback (owner decision 2026-09-11, see
  // docs/IMPLEMENTATION_PLAN.md) — omitting effectiveFrom from the request lets the API apply
  // its own EFFECTIVE_FROM_ALL_TIME default, so this component never needs to know that sentinel
  // value. Un-checking reveals a normal date picker for the rare genuine time-scoped version.
  const [applyToAllHistory, setApplyToAllHistory] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState(() => toDatetimeLocal(new Date()));
  const [publishedBy, setPublishedBy] = useState("");
  const [outcome, setOutcome] = useState<PublishOutcome>({ status: "idle" });
  const [moduleChanges, setModuleChanges] = useState<ModuleChange[]>([]);
  // Milestone 96 (owner request): by default the changed modules publish with the map.
  const [moduleChoice, setModuleChoice] = useState<ModulePublishChoice>("withModules");

  // Milestone 96: which of this map's modules have unpublished drafts — re-read whenever the
  // map's draft changes and after a publish.
  async function loadModuleChanges(signal?: AbortSignal): Promise<void> {
    try {
      const response = await fetch(
        `/api/v1/editor/maps/${encodeURIComponent(slug)}/module-changes`,
        { signal: signal ?? null },
      );
      if (!response.ok) return;
      const body = await readApiJson<{ modules?: ModuleChange[] }>(response);
      setModuleChanges(body.modules ?? []);
    } catch {
      // Aborted or offline: the publish itself still reports anything wrong.
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadModuleChanges(controller.signal);
    return () => controller.abort();
  }, [slug, syncedRevision]);
  const pendingModules = moduleChanges.filter(
    (change) => change.status === "changed" || change.status === "never_published",
  );
  const neverPublished = pendingModules.filter((change) => change.status === "never_published");

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
          publishModules:
            moduleChoice === "withModules" && pendingModules.length > 0
              ? pendingModules.map((change) => ({
                  slug: change.slug,
                  expectedRevision: change.draftRevision,
                }))
              : undefined,
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
        kind?: "map" | "module";
        cascade?: CascadeOutcome[];
        modules?: Array<{ slug: string; versionNumber: number }>;
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
        kind: body.kind ?? "map",
        cascade: body.cascade ?? [],
        modules: body.modules ?? [],
      });
      void loadModuleChanges();
      // Milestone 85/96: after publishing a module, or a map with modules, stay here so the
      // author sees what was published and which maps were republished (and any that couldn't be).
      if (body.kind !== "module" && (body.modules ?? []).length === 0) onPublished();
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

      {/* Milestone 99: publishing is its own permission; the API refuses it without. */}
      {canPublish ? (
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
          {pendingModules.length > 0 ? (
            <fieldset className="module-publish-choice">
              <legend>Modules with unpublished changes</legend>
              <ul className="module-publish-choice__list">
                {pendingModules.map((change) => (
                  <li key={change.slug}>
                    <strong>{change.name ?? change.slug}</strong>{" "}
                    {change.status === "never_published"
                      ? "— never published"
                      : `— changed since version ${change.publishedVersion}`}
                  </li>
                ))}
              </ul>
              <label className="field field--checkbox">
                <input
                  type="radio"
                  name="module-publish-choice"
                  checked={moduleChoice === "withModules"}
                  onChange={() => setModuleChoice("withModules")}
                />
                Publish {pendingModules.length === 1 ? "this module" : "these modules"} with the map
                (recommended)
              </label>
              <label className="field field--checkbox">
                <input
                  type="radio"
                  name="module-publish-choice"
                  checked={moduleChoice === "mapOnly"}
                  onChange={() => setModuleChoice("mapOnly")}
                />
                Publish the map only, with the modules&apos; published versions
              </label>
              {moduleChoice === "mapOnly" && neverPublished.length > 0 ? (
                <p role="alert" className="publish-result publish-result--error">
                  {neverPublished.map((change) => change.name ?? change.slug).join(", ")}{" "}
                  {neverPublished.length === 1 ? "has" : "have"} never been published, so the map
                  can&apos;t be assembled without {neverPublished.length === 1 ? "it" : "them"}.
                </p>
              ) : null}
            </fieldset>
          ) : null}
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
      ) : (
        <p className="map-inspector__note">
          Publishing needs the Publish permission. Your changes are saved to the draft.
        </p>
      )}

      {outcome.status === "published" && outcome.kind === "map" ? (
        <div className="publish-result publish-result--success">
          <p>
            Published version {outcome.versionNumber}, effective from {outcome.effectiveFrom}.
            {outcome.modules.length > 0
              ? ` Published with it: ${outcome.modules
                  .map((m) => `${m.slug} (module version ${m.versionNumber})`)
                  .join(", ")}.`
              : ""}
          </p>
          {outcome.cascade.length > 0 ? (
            <>
              <p>Other maps using those modules were republished:</p>
              <CascadeList cascade={outcome.cascade} />
            </>
          ) : null}
        </div>
      ) : null}
      {outcome.status === "published" && outcome.kind === "module" ? (
        <div className="publish-result publish-result--success">
          <p>
            Published module version {outcome.versionNumber}.
            {outcome.cascade.length === 0
              ? " No published map uses this module yet."
              : " Maps using it were republished:"}
          </p>
          {outcome.cascade.length > 0 ? <CascadeList cascade={outcome.cascade} /> : null}
        </div>
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

function CascadeList({ cascade }: { cascade: CascadeOutcome[] }): JSX.Element {
  return (
    <ul className="cascade-list">
      {cascade.map((map) => (
        <li key={map.slug} className={map.ok ? "" : "cascade-list__failed"}>
          <strong>{map.slug}</strong>{" "}
          {map.ok
            ? `— now version ${map.versionNumber}`
            : `— not republished: ${(map.errors ?? []).map((e) => e.message).join("; ")}`}
        </li>
      ))}
    </ul>
  );
}
