import { useEffect, useState } from "react";
import type { MapBinding } from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import { useObservedAreas, useObservedBerths } from "./useBindingAutocomplete.js";

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}

function TextField({ label, value, onCommit }: TextFieldProps): JSX.Element {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label className="field">
      {label}
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onCommit(local);
        }}
      />
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

function NumberField({ label, value, onCommit }: NumberFieldProps): JSX.Element {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <label className="field">
      {label}
      <input
        type="number"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const parsed = Number(local);
          if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        }}
      />
    </label>
  );
}

function IdField({
  elementId,
  existingIds,
  onCommit,
}: {
  elementId: string;
  existingIds: string[];
  onCommit: (newId: string) => void;
}): JSX.Element {
  const [local, setLocal] = useState(elementId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLocal(elementId);
    setError(null);
  }, [elementId]);

  function commit(): void {
    const trimmed = local.trim();
    if (trimmed === elementId) return;
    if (!trimmed) {
      setError("Element ID can't be empty");
      setLocal(elementId);
      return;
    }
    if (existingIds.includes(trimmed)) {
      setError(`"${trimmed}" is already in use`);
      setLocal(elementId);
      return;
    }
    setError(null);
    onCommit(trimmed);
  }

  return (
    <label className="field">
      Element ID
      <input
        type="text"
        className="mono"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
      />
      {error ? <span className="badge badge--danger">{error}</span> : null}
    </label>
  );
}

function BindingFields({
  elementId,
  binding,
}: {
  elementId: string;
  binding: MapBinding | undefined;
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const areas = useObservedAreas();
  const currentArea = binding?.type === "tdBerth" ? binding.tdArea : null;
  const berths = useObservedBerths(currentArea);

  function commitBinding(tdArea: string, berth: string): void {
    if (!tdArea || !berth) return;
    const newBinding: MapBinding = {
      id: binding?.id ?? `bind-${elementId}`,
      elementId,
      type: "tdBerth",
      tdArea,
      berth,
      allowDuplicate: binding?.type === "tdBerth" ? binding.allowDuplicate : false,
    };
    dispatch({
      type: "dispatchCommand",
      command: { type: "setBinding", elementId, binding: newBinding },
    });
  }

  return (
    <fieldset>
      <legend>TD binding</legend>
      <label className="field">
        TD area
        <input
          list="observed-td-areas"
          defaultValue={currentArea ?? ""}
          onBlur={(e) =>
            commitBinding(e.target.value, binding?.type === "tdBerth" ? binding.berth : "")
          }
        />
        <datalist id="observed-td-areas">
          {areas.map((area) => (
            <option key={area} value={area} />
          ))}
        </datalist>
      </label>
      <label className="field">
        Berth
        <input
          list="observed-berths"
          defaultValue={binding?.type === "tdBerth" ? binding.berth : ""}
          onBlur={(e) => commitBinding(currentArea ?? "", e.target.value)}
        />
        <datalist id="observed-berths">
          {berths.map((berth) => (
            <option key={berth} value={berth} />
          ))}
        </datalist>
      </label>
      {binding ? (
        <button
          type="button"
          className="btn"
          onClick={() =>
            dispatch({
              type: "dispatchCommand",
              command: { type: "setBinding", elementId, binding: null },
            })
          }
        >
          Clear binding
        </button>
      ) : null}
    </fieldset>
  );
}

/** docs/MAP_EDITOR_SPEC.md §6: "Right properties/binding/validation panel." Shows editable
 * fields for exactly one selected element; deliberately shows nothing actionable for
 * zero/multi-selection (bulk property editing isn't in this pass's scope). */
export function PropertyPanel(): JSX.Element {
  const { document: doc, selection } = useEditorState();
  const dispatch = useEditorDispatch();

  if (selection.length !== 1) {
    return (
      <aside aria-label="Properties" className="panel-card">
        <h3>Properties</h3>
        <p className="panel-card--empty">
          {selection.length === 0 ? "No selection." : `${selection.length} elements selected.`}
        </p>
      </aside>
    );
  }

  const elementId = selection[0]!;
  const element = doc.elements.find((el) => el.id === elementId);
  if (!element) {
    return <aside aria-label="Properties" className="panel-card" />;
  }
  const binding = doc.bindings.find((b) => b.elementId === elementId);

  function setProp(property: string, value: unknown): void {
    dispatch({
      type: "dispatchCommand",
      command: { type: "setProperty", elementId, property, value },
    });
  }

  const existingIds = doc.elements.filter((el) => el.id !== elementId).map((el) => el.id);

  return (
    <aside aria-label="Properties" className="panel-card">
      <h3>Properties</h3>
      <p className="field-row">
        <span className="badge">{element.type}</span>
      </p>
      <IdField
        elementId={elementId}
        existingIds={existingIds}
        onCommit={(newId) =>
          dispatch({
            type: "dispatchCommand",
            command: { type: "renameElement", elementId, newId },
          })
        }
      />

      {element.type === "berth" && (
        <>
          <TextField
            label="Display name"
            value={element.displayName}
            onCommit={(v) => setProp("displayName", v)}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <NumberField label="Width" value={element.width} onCommit={(v) => setProp("width", v)} />
          <NumberField
            label="Height"
            value={element.height}
            onCommit={(v) => setProp("height", v)}
          />
          <BindingFields elementId={elementId} binding={binding} />
        </>
      )}

      {element.type === "signal" && (
        <>
          <TextField
            label="Label"
            value={element.label ?? ""}
            onCommit={(v) => setProp("label", v || undefined)}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <label className="field">
            Symbol style
            <select
              value={element.symbolStyle}
              onChange={(e) => setProp("symbolStyle", e.target.value)}
            >
              <option value="signal-blank">blank</option>
              <option value="signal-on">on</option>
              <option value="signal-off">off</option>
            </select>
          </label>
        </>
      )}

      {element.type === "label" && (
        <>
          <TextField label="Text" value={element.text} onCommit={(v) => setProp("text", v)} />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
        </>
      )}

      {element.type === "boundary" && (
        <>
          <TextField label="Name" value={element.name} onCommit={(v) => setProp("name", v)} />
          <TextField
            label="Adjacent map slug"
            value={element.adjacentMapSlug ?? ""}
            onCommit={(v) => setProp("adjacentMapSlug", v || undefined)}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
        </>
      )}

      {element.type === "platform" && (
        <>
          <TextField
            label="Number"
            value={element.number ?? ""}
            onCommit={(v) => setProp("number", v || undefined)}
          />
          <TextField
            label="Name"
            value={element.name ?? ""}
            onCommit={(v) => setProp("name", v || undefined)}
          />
        </>
      )}

      {element.type === "trackPath" && (
        <TextField
          label="Line"
          value={element.line ?? ""}
          onCommit={(v) => setProp("line", v || undefined)}
        />
      )}

      <button
        type="button"
        className="btn"
        style={{ marginTop: "0.4rem" }}
        onClick={() =>
          dispatch({
            type: "dispatchCommand",
            command: { type: "deleteElements", elementIds: [elementId] },
          })
        }
      >
        Delete
      </button>
    </aside>
  );
}
