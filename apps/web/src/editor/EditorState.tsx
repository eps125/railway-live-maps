import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from "react";
import type { MapDocument } from "@railway/map-schema";
import { applyCommand, type EditorCommand } from "./commands.js";

export type ToolMode =
  "select" | "trackPath" | "berth" | "signal" | "platform" | "label" | "boundary";

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
  | { type: "setDocument"; document: MapDocument }
  | { type: "markSynced" };

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "dispatchCommand": {
      const { doc, inverse } = applyCommand(state.document, action.command);
      return { ...state, document: doc, past: [...state.past, inverse], future: [], dirty: true };
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
    case "setDocument":
      return {
        ...state,
        document: action.document,
        past: [],
        future: [],
        selection: [],
        dirty: false,
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
