import { useEffect, useRef, useState } from "react";
import {
  MapDocumentSchema,
  validateMapDocument,
  type MapElement,
  type MapBinding,
} from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";

const PASTE_OFFSET = 20;

function cloneWithNewId<T extends { id: string }>(item: T): T {
  return { ...item, id: `${item.id}-copy-${Math.random().toString(36).slice(2, 6)}` };
}

/** docs/MAP_EDITOR_SPEC.md §7: undo/redo, copy/cut/paste/duplicate/repeat-offset, JSON
 * import/export. Keyboard shortcuts mirror the buttons (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or
 * Ctrl+Y, Ctrl/Cmd+C/X/V/D) — a visible shortcut-help overlay is deferred (see the M11/M12
 * plan's scope decision), but the shortcuts themselves are live. */
export function Toolbar({
  onImportError,
}: {
  onImportError: (message: string) => void;
}): JSX.Element {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [clipboard, setClipboard] = useState<{
    elements: MapElement[];
    bindings: MapBinding[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function copySelection(): void {
    const idSet = new Set(state.selection);
    const elements = state.document.elements.filter((el) => idSet.has(el.id));
    const bindings = state.document.bindings.filter((b) => idSet.has(b.elementId));
    if (elements.length > 0) setClipboard({ elements, bindings });
  }

  function cutSelection(): void {
    copySelection();
    if (state.selection.length > 0) {
      dispatch({
        type: "dispatchCommand",
        command: { type: "deleteElements", elementIds: state.selection },
      });
    }
  }

  function pasteClipboard(): void {
    if (!clipboard) return;
    const idMap = new Map<string, string>();
    const newElements = clipboard.elements.map((el) => {
      const copy = cloneWithNewId(el);
      idMap.set(el.id, copy.id);
      if ("x" in copy) {
        copy.x += PASTE_OFFSET;
        copy.y += PASTE_OFFSET;
      } else {
        copy.points = copy.points.map((p) => ({ x: p.x + PASTE_OFFSET, y: p.y + PASTE_OFFSET }));
      }
      return copy;
    });
    const newBindings = clipboard.bindings.map((binding) => {
      const copy = cloneWithNewId(binding);
      copy.elementId = idMap.get(binding.elementId) ?? binding.elementId;
      return copy;
    });
    for (const element of newElements) {
      if ("bindingId" in element && element.bindingId) {
        const newBindingId = newBindings.find((b) => b.elementId === element.id)?.id;
        if (newBindingId) {
          (element as { bindingId?: string }).bindingId = newBindingId;
        }
      }
    }
    dispatch({
      type: "dispatchCommand",
      command: { type: "addElement", elements: newElements, bindings: newBindings },
    });
    dispatch({ type: "setSelection", ids: newElements.map((el) => el.id) });
  }

  function duplicateSelection(): void {
    copySelection();
    pasteClipboard();
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      ) {
        return;
      }
      if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (e.key.toLowerCase() === "c") {
        copySelection();
      } else if (e.key.toLowerCase() === "x") {
        cutSelection();
      } else if (e.key.toLowerCase() === "v") {
        pasteClipboard();
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.selection, clipboard, state.document]);

  function exportJson(): void {
    const blob = new Blob([JSON.stringify(state.document, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${state.document.map.id || "map"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file: File): void {
    file
      .text()
      .then((text) => {
        const json: unknown = JSON.parse(text);
        const validation = validateMapDocument(json);
        if (!validation.valid) {
          onImportError(`Import failed: ${validation.errors.map((e) => e.message).join("; ")}`);
          return;
        }
        const parsed = MapDocumentSchema.parse(json);
        dispatch({ type: "setDocument", document: parsed });
      })
      .catch((error: unknown) => {
        onImportError(error instanceof Error ? error.message : "Failed to import file");
      });
  }

  return (
    <div role="toolbar" aria-label="Editor toolbar" className="editor-toolbar">
      <div className="btn-group">
        <button
          type="button"
          className="btn"
          disabled={state.past.length === 0}
          onClick={() => dispatch({ type: "undo" })}
        >
          Undo
        </button>
        <button
          type="button"
          className="btn"
          disabled={state.future.length === 0}
          onClick={() => dispatch({ type: "redo" })}
        >
          Redo
        </button>
      </div>
      <div className="editor-toolbar__divider" />
      <div className="btn-group">
        <button
          type="button"
          className="btn"
          disabled={state.selection.length === 0}
          onClick={copySelection}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn"
          disabled={state.selection.length === 0}
          onClick={cutSelection}
        >
          Cut
        </button>
        <button type="button" className="btn" disabled={!clipboard} onClick={pasteClipboard}>
          Paste
        </button>
        <button
          type="button"
          className="btn"
          disabled={state.selection.length === 0}
          onClick={duplicateSelection}
        >
          Duplicate
        </button>
      </div>
      <div className="editor-toolbar__divider" />
      <div className="btn-group">
        <button type="button" className="btn" onClick={exportJson}>
          Export JSON
        </button>
        <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
          Import JSON
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importJson(file);
            e.target.value = "";
          }}
        />
      </div>
      <div style={{ flex: 1 }} />
      {state.dirty ? (
        <span className="badge badge--warning">Unsaved changes</span>
      ) : (
        <span className="badge badge--success">Saved</span>
      )}
    </div>
  );
}
