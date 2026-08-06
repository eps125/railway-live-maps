import { useState } from "react";
import { Toolbar } from "./Toolbar.js";
import { ToolPalette } from "./ToolPalette.js";
import { EditorCanvas } from "./EditorCanvas.js";
import { PropertyPanel } from "./PropertyPanel.js";
import { LayersPanel } from "./LayersPanel.js";
import { ValidationPanel } from "./ValidationPanel.js";
import { useTestModePanel } from "./TestModePanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { useDraftSync } from "./useDraftSync.js";

export interface EditorWorkspaceProps {
  slug: string;
  initialRevision: number;
}

const SYNC_STATUS_TEXT: Record<string, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  conflict: "Someone/something else changed this draft",
  error: "Failed to save — will retry on the next edit",
};

type ViewMode = "design" | "test" | "review";

/** Milestone 11/12 editor layout (docs/MAP_EDITOR_SPEC.md §6: top toolbar, left tool palette,
 * central canvas, right properties/binding/validation panel; four modes — Layout, Binding,
 * Test, Review). Layout+Binding are fused here (bindings are already editable in
 * `PropertyPanel` without a separate modal), so the view switcher covers Design/Test/Review. */
export function EditorWorkspace({ slug, initialRevision }: EditorWorkspaceProps): JSX.Element {
  const [importError, setImportError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("design");
  const draftSync = useDraftSync(slug, initialRevision);
  const testMode = useTestModePanel(slug);

  return (
    <section aria-label="Map editor">
      <h2>Editing &quot;{slug}&quot;</h2>
      <Toolbar onImportError={setImportError} />
      <div role="status" aria-live="polite">
        {SYNC_STATUS_TEXT[draftSync.status]}
        {draftSync.status === "conflict" ? (
          <>
            {" "}
            (server is at revision {draftSync.conflictRevision ?? "?"}){" "}
            <button type="button" onClick={draftSync.reloadFromServer}>
              Reload from server
            </button>
          </>
        ) : null}
      </div>
      {importError ? <p role="alert">{importError}</p> : null}

      <nav aria-label="Editor view mode">
        {(["design", "test", "review"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={viewMode === mode}
            onClick={() => setViewMode(mode)}
          >
            {mode[0]!.toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </nav>

      <div style={{ display: "flex", gap: "1rem" }}>
        <ToolPalette />
        <EditorCanvas previewState={viewMode === "test" ? testMode.previewState : undefined} />
        <div>
          {viewMode === "design" ? (
            <>
              <PropertyPanel />
              <LayersPanel />
              <ValidationPanel slug={slug} />
            </>
          ) : null}
          {viewMode === "test" ? testMode.panel : null}
          {viewMode === "review" ? (
            <ReviewPanel
              slug={slug}
              syncedRevision={draftSync.syncedRevision}
              onPublished={() => setViewMode("design")}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
