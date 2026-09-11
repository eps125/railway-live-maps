import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from "react";
import type { MapDocument } from "@railway/map-schema";
import { applyCommand, type EditorCommand } from "./commands.js";

export type ToolMode =
  | "select"
  | "multiselect"
  | "trackPath"
  | "berth"
  | "signal"
  | "platform"
  | "platformNumber"
  | "station"
  | "label"
  | "boundary";

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface EditorState {
  document: MapDocument;
  selection: string[];
  /** Inverse commands, most-recently-applied last — undo pops and applies one. */
  past: EditorCommand[];
  /** Commands undone, most-recently-undone first — redo re-applies one. */
  future: EditorCommand[];
  toolMode: ToolMode;
  viewport: Viewport;
  /** True whenever `document` has changed since the last `markSynced` — drives `useDraftSync`'s
   * autosave and the "unsaved changes" indicator. */
  dirty: boolean;
}

export type EditorAction =
  | { type: "dispatchCommand"; command: EditorCommand }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "setSelection"; ids: string[] }
  | { type: "setToolMode"; mode: ToolMode }
  | { type: "setViewport"; viewport: Viewport }
  /** `dirty` defaults to `false` — the common case is loading content the server already has
   * (initial load, `useDraftSync`'s `reloadFromServer`), which is by definition already synced.
   * A caller loading content the server has NOT seen (Toolbar.tsx's JSON import) must pass
   * `dirty: true` explicitly, or the change silently never queues for autosave — exactly what
   * happened before this field existed: importing a JSON file visually updated the canvas but,
   * since this action unconditionally set `dirty: false`, `useDraftSync`'s autosave effect
   * (gated on `dirty`) never fired, so the import was never actually persisted and a page
   * refresh reloaded the server's untouched draft, making the import look like it "reverted". */
  | { type: "setDocument"; document: MapDocument; dirty?: boolean }
  /** Map-level display name (shown as the map's heading on the public renderer). Not part of
   * the element command model, so it's a plain state update with no undo entry. */
  | { type: "setMapName"; name: string }
  | { type: "markSynced" };

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "dispatchCommand": {
      const { doc, inverse } = applyCommand(state.document, action.command);
      let selection = state.selection;
      const command = action.command;
      if (command.type === "renameElement") {
        const { elementId, newId } = command;
        selection = state.selection.map((id) => (id === elementId ? newId : id));
      }
      return {
        ...state,
        document: doc,
        selection,
        past: [...state.past, inverse],
        future: [],
        dirty: true,
      };
    }
    case "undo": {
      const lastInverse = state.past.at(-1);
      if (!lastInverse) return state;
      const { doc, inverse: redoCommand } = applyCommand(state.document, lastInverse);
      return {
        ...state,
        document: doc,
        past: state.past.slice(0, -1),
        future: [redoCommand, ...state.future],
        dirty: true,
      };
    }
    case "redo": {
      const nextCommand = state.future[0];
      if (!nextCommand) return state;
      const { doc, inverse } = applyCommand(state.document, nextCommand);
      return {
        ...state,
        document: doc,
        past: [...state.past, inverse],
        future: state.future.slice(1),
        dirty: true,
      };
    }
    case "setSelection":
      return { ...state, selection: action.ids };
    case "setToolMode":
      return { ...state, toolMode: action.mode };
    case "setViewport":
      return { ...state, viewport: action.viewport };
    case "setMapName":
      if (action.name === state.document.map.name) return state;
      return {
        ...state,
        document: { ...state.document, map: { ...state.document.map, name: action.name } },
        dirty: true,
      };
    case "setDocument":
      return {
        ...state,
        document: action.document,
        past: [],
        future: [],
        selection: [],
        dirty: action.dirty ?? false,
      };
    case "markSynced":
      return { ...state, dirty: false };
  }
}

function initialState(document: MapDocument): EditorState {
  return {
    document,
    selection: [],
    past: [],
    future: [],
    toolMode: "select",
    viewport: { x: 0, y: 0, scale: 1 },
    dirty: false,
  };
}

const StateContext = createContext<EditorState | null>(null);
const DispatchContext = createContext<Dispatch<EditorAction> | null>(null);

export function EditorStateProvider({
  initialDocument,
  children,
}: {
  initialDocument: MapDocument;
  children: ReactNode;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialDocument, initialState);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useEditorState(): EditorState {
  const state = useContext(StateContext);
  if (!state) throw new Error("useEditorState must be used within an EditorStateProvider");
  return state;
}

export function useEditorDispatch(): Dispatch<EditorAction> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error("useEditorDispatch must be used within an EditorStateProvider");
  return dispatch;
}
