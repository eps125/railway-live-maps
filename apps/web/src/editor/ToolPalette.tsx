import { useEditorDispatch, useEditorState, type ToolMode } from "./EditorState.js";

const TOOLS: Array<{ mode: ToolMode; label: string }> = [
  { mode: "select", label: "Select" },
  { mode: "multiselect", label: "Multiselect" },
  { mode: "trackPath", label: "Track" },
  { mode: "berth", label: "Berth" },
  { mode: "signal", label: "Signal" },
  { mode: "platform", label: "Platform" },
  { mode: "label", label: "Label" },
  { mode: "boundary", label: "Boundary" },
];

/** docs/MAP_EDITOR_SPEC.md §6: "Left symbol/tool palette." Clicking a tool arms it; the next
 * click on empty canvas (`EditorCanvas.tsx`) places a default-sized element of that type and
 * switches back to Select — except Multiselect, armed the same way but consumed by a drag
 * (rubber-band select) rather than a click, also switching back to Select once released. */
export function ToolPalette(): JSX.Element {
  const { toolMode } = useEditorState();
  const dispatch = useEditorDispatch();

  return (
    <nav aria-label="Editor tools" className="tool-palette">
      {TOOLS.map((tool) => (
        <button
          key={tool.mode}
          type="button"
          className="tool-palette__button"
          aria-pressed={toolMode === tool.mode}
          onClick={() => dispatch({ type: "setToolMode", mode: tool.mode })}
        >
          {tool.label}
        </button>
      ))}
    </nav>
  );
}
