import { useMemo, useState } from "react";
import { Toolbar } from "./Toolbar.js";
import { ToolPalette } from "./ToolPalette.js";
import { EditorCanvas } from "./EditorCanvas.js";
import { PropertyPanel } from "./PropertyPanel.js";
import { LayersPanel } from "./LayersPanel.js";
import { ValidationPanel } from "./ValidationPanel.js";
import { useTestModePanel } from "./TestModePanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { useDraftSync } from "./useDraftSync.js";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import { useLiveSClassStates } from "./useLiveSignalStates.js";
import { SignalToolDialog } from "./SignalToolDialog.js";
import { JoinsPanel, ModulesPanel } from "./ModulesPanel.js";
import { useContextMap, useModuleCatalogue, useModuleDocs } from "./useModules.js";
import { assemblyBackdrop, contextBackdrop } from "./modulesSupport.js";
import { readApiJson } from "./apiJson.js";
import { navigate } from "../useRoute.js";

export interface EditorWorkspaceProps {
  slug: string;
  initialRevision: number;
  /** Milestone 85: a module gets the Join tool and a Joins panel; a map gets the Modules panel. */
  kind?: "map" | "module";
  /** Milestone 85: an admin can make a module from a selection. */
  isAdmin?: boolean;
  /** Milestone 85: editing a module inside this assembled map (`?in=`) — the rest of the map is
   * drawn around it. */
  contextSlug?: string | null;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
export function EditorWorkspace({
  slug,
  initialRevision,
  kind = "map",
  isAdmin = false,
  contextSlug = null,
}: EditorWorkspaceProps): JSX.Element {
  const [importError, setImportError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("design");
  const [signalToolOpen, setSignalToolOpen] = useState(false);
  const draftSync = useDraftSync(slug, initialRevision);
  const testMode = useTestModePanel(slug);
  const { document: currentDocument, selection } = useEditorState();
  const dispatch = useEditorDispatch();
  const liveStates = useLiveSClassStates(slug, currentDocument);

  // Milestone 85 (docs/adr/0019): modules. A map shows the modules it is assembled from behind
  // its own elements; a module opened from a map (`?in=`) shows the rest of that map around it.
  const isModule = kind === "module";
  const contextDoc = useContextMap(isModule ? contextSlug : null);
  const moduleSlugs = isModule
    ? (contextDoc?.modules ?? []).map((use) => use.slug).filter((s) => s !== slug)
    : (currentDocument.modules ?? []).map((use) => use.slug);
  const { modules, reload: reloadModules } = useModuleDocs(moduleSlugs);
  const catalogue = useModuleCatalogue(slug);
  const assembly = useMemo(() => {
    if (isModule)
      return contextDoc ? contextBackdrop(slug, currentDocument, contextDoc, modules) : null;
    return (currentDocument.modules ?? []).length > 0
      ? assemblyBackdrop(currentDocument, modules)
      : null;
  }, [isModule, contextDoc, slug, currentDocument, modules]);

  /** Leave for another editor page, saving first so nothing is lost. */
  async function openPath(path: string): Promise<void> {
    const saved = await draftSync.flush();
    if (saved === null && !window.confirm("Your latest changes couldn't be saved. Leave anyway?")) {
      return;
    }
    navigate(path);
  }

  function moveModule(moduleSlug: string, x: number, y: number): void {
    const uses = currentDocument.modules ?? [];
    dispatch({
      type: "dispatchCommand",
      command: {
        type: "setModules",
        modules: uses.map((use) =>
          use.slug === moduleSlug ? { ...use, placement: { kind: "at", x, y } } : use,
        ),
      },
    });
  }

  async function makeModule(): Promise<void> {
    if (selection.length === 0) return;
    const name = window.prompt(
      `Make a module from the ${selection.length} selected element(s). Name of the new module:`,
    );
    if (!name?.trim()) return;
    const moduleSlug = slugify(name);
    const revision = await draftSync.flush();
    if (revision === null) {
      window.alert("Your latest changes couldn't be saved, so the module wasn't made.");
      return;
    }
    const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/extract-module`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elementIds: selection,
        moduleSlug,
        moduleName: name.trim(),
        expectedRevision: revision,
      }),
    });
    const body = await readApiJson<{
      movedElements?: number;
      keptInMap?: string[];
      error?: { message?: string };
    }>(response);
    if (!response.ok) {
      window.alert(body.error?.message ?? "The module couldn't be made.");
      return;
    }
    draftSync.reloadFromServer();
    reloadModules();
    const kept = body.keptInMap?.length
      ? ` ${body.keptInMap.length} element(s) stayed in this map because they refer to things outside the selection.`
      : "";
    window.alert(
      `Module "${name.trim()}" made with ${body.movedElements ?? 0} element(s), placed exactly where they were.${kept} Publish the module, then this map.`,
    );
  }

  const syncModifier =
    draftSync.status === "conflict" || draftSync.status === "error"
      ? draftSync.status
      : draftSync.status === "saved"
        ? "saved"
        : "idle";

  return (
    <section aria-label="Map editor" className="editor-page">
      <div className="editor-header">
        <div className="editor-header__title">
          <h2>
            {isModule ? "Editing module" : "Editing"} &quot;{slug}&quot;
          </h2>
          {isModule && contextSlug ? (
            <p className="editor-header__context">
              Shown inside {contextSlug}
              {assembly === null && contextDoc
                ? " (this module isn't placed in that map)"
                : ""} ·{" "}
              <a
                href={`/editor/${encodeURIComponent(contextSlug)}`}
                onClick={(e) => {
                  e.preventDefault();
                  void openPath(`/editor/${encodeURIComponent(contextSlug)}`);
                }}
              >
                Back to {contextSlug}
              </a>
            </p>
          ) : null}
          <div
            role="status"
            aria-live="polite"
            className={`sync-status sync-status--${syncModifier}`}
          >
            {SYNC_STATUS_TEXT[draftSync.status]}
            {draftSync.status === "conflict" ? (
              <>
                {" "}
                (server is at revision {draftSync.conflictRevision ?? "?"}){" "}
                <button type="button" className="btn" onClick={draftSync.reloadFromServer}>
                  Reload from server
                </button>
              </>
            ) : null}
          </div>
        </div>

        <nav aria-label="Editor view mode" className="view-tabs">
          {(["design", "test", "review"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="view-tabs__button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
            >
              {mode[0]!.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      <Toolbar
        onImportError={setImportError}
        onOpenSignalTool={() => setSignalToolOpen(true)}
        onMakeModule={isAdmin && !isModule ? () => void makeModule() : undefined}
      />
      {importError ? (
        <p role="alert" className="editor-import-error">
          {importError}
        </p>
      ) : null}

      <div className="editor-body">
        <div className="editor-sidebar">
          <ToolPalette showJoinTool={isModule} />
        </div>
        <div className="editor-canvas-frame">
          <EditorCanvas
            previewState={viewMode === "test" ? testMode.previewState : undefined}
            signalStates={liveStates.signals}
            routeStates={liveStates.routes}
            backdrop={assembly?.items}
            onMoveModule={isModule ? undefined : moveModule}
          />
        </div>
        <div className="editor-panels">
          {viewMode === "design" ? (
            <>
              <PropertyPanel />
              {isModule ? (
                <JoinsPanel
                  moduleSlug={slug}
                  usedBy={catalogue.usedBy}
                  onOpen={(path) => void openPath(path)}
                />
              ) : (
                <ModulesPanel
                  slug={slug}
                  modules={modules}
                  available={catalogue.available}
                  backdrop={assembly?.items ?? []}
                  offsets={assembly?.offsets ?? new Map()}
                  issues={assembly?.issues ?? []}
                  onOpen={(path) => void openPath(path)}
                />
              )}
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
      {signalToolOpen ? <SignalToolDialog onClose={() => setSignalToolOpen(false)} /> : null}
    </section>
  );
}
