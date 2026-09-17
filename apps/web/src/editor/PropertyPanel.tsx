import { useEffect, useState } from "react";
import { Z_INDEX_LAYER_BAND, type MapDocument, type TdBerthBinding } from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import { useObservedAreas, useObservedBerths } from "./useBindingAutocomplete.js";

const MAX_COMBINED_BERTH_MEMBERS = 4;

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  /** Render a resizable textarea instead of a single-line input — for label text, which can
   * span multiple lines (each newline wraps in the renderer). */
  multiline?: boolean;
}

function TextField({ label, value, onCommit, multiline }: TextFieldProps): JSX.Element {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = (): void => {
    if (local !== value) onCommit(local);
  };
  return (
    <label className="field">
      {label}
      {multiline ? (
        <textarea
          rows={3}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          type="text"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
        />
      )}
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

/** One additional combined-berth member row (docs/MAP_EDITOR_SPEC.md's berth section, owner
 * request 2026-09-17) — same controlled-input-plus-onBlur-commit shape as the primary TD
 * area/berth fields above, just scoped to one member so each row keeps its own uncommitted
 * edit independently. */
function CombinedMemberRow({
  member,
  onCommit,
  onRemove,
}: {
  member: TdBerthBinding;
  onCommit: (tdArea: string, berth: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [area, setArea] = useState(member.tdArea);
  const [berth, setBerth] = useState(member.berth);
  useEffect(() => {
    setArea(member.tdArea);
    setBerth(member.berth);
  }, [member.id, member.tdArea, member.berth]);
  const berths = useObservedBerths(area || null);

  function commit(): void {
    if (!area || !berth) return;
    if (area === member.tdArea && berth === member.berth) return;
    onCommit(area, berth);
  }

  return (
    <div className="field-row">
      <input
        aria-label={`Combined member ${member.combinedOrder ?? ""} TD area`}
        list="observed-td-areas"
        value={area}
        onChange={(e) => setArea(e.target.value)}
        onBlur={commit}
      />
      <input
        aria-label={`Combined member ${member.combinedOrder ?? ""} berth`}
        list={`observed-berths-${member.id}`}
        value={berth}
        onChange={(e) => setBerth(e.target.value)}
        onBlur={commit}
      />
      <datalist id={`observed-berths-${member.id}`}>
        {berths.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <button type="button" className="btn" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

/** `bindings` is every `tdBerth` binding sharing `elementId`, sorted by `combinedOrder ?? 1` —
 * exactly one for a plain berth, up to 4 for a combined berth (owner request 2026-09-17,
 * docs/MAP_EDITOR_SPEC.md's berth section: a physical split-berth group with no room to draw
 * each member separately, displayed joined in this order — e.g. "A001 B001"). The whole group
 * commits together (`setBinding` for exactly one, `setCombinedBindings` for more), so undo
 * restores the prior group in a single step. */
function BindingFields({
  elementId,
  bindings,
}: {
  elementId: string;
  bindings: TdBerthBinding[];
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const areas = useObservedAreas();
  const primary = bindings[0];
  const initialArea = primary?.tdArea ?? "";
  const initialBerth = primary?.berth ?? "";

  // Both fields are controlled and share this local state — `defaultValue`-based uncontrolled
  // inputs here previously (a) never reset when switching to a different element, so the
  // previously-selected berth's binding stayed visible/editable after selecting an unbound one,
  // and (b) committed each field independently on its own blur, reading the *other* field's
  // still-uncommitted value from `binding` — which is empty for a brand-new element, so filling
  // in area then berth (or vice versa) always fell back to an empty counterpart and silently
  // no-opped both times. Keying local state on `elementId` and committing both fields together
  // fixes both.
  const [localArea, setLocalArea] = useState(initialArea);
  const [localBerth, setLocalBerth] = useState(initialBerth);
  useEffect(() => {
    setLocalArea(initialArea);
    setLocalBerth(initialBerth);
  }, [elementId, initialArea, initialBerth]);

  const berths = useObservedBerths(localArea || null);

  /** Renumbers `combinedOrder` 1..N by array position, or clears it entirely for a lone
   * survivor — validate.ts requires every member of a >1 group to have a distinct order, and a
   * lone binding to have none at all. */
  function normalizeOrders(group: TdBerthBinding[]): TdBerthBinding[] {
    return group.map((b, i) => ({
      ...b,
      combinedOrder: group.length > 1 ? i + 1 : undefined,
    }));
  }

  function commitGroup(next: TdBerthBinding[]): void {
    const normalized = normalizeOrders(next);
    if (normalized.length <= 1) {
      dispatch({
        type: "dispatchCommand",
        command: { type: "setBinding", elementId, binding: normalized[0] ?? null },
      });
    } else {
      dispatch({
        type: "dispatchCommand",
        command: { type: "setCombinedBindings", elementId, bindings: normalized },
      });
    }
  }

  function commitBinding(tdArea: string, berth: string): void {
    if (!tdArea || !berth) return;
    if (tdArea === initialArea && berth === initialBerth) return;
    const newPrimary: TdBerthBinding = {
      id: primary?.id ?? `bind-${elementId}`,
      elementId,
      type: "tdBerth",
      tdArea,
      berth,
      allowDuplicate: primary?.allowDuplicate ?? false,
    };
    commitGroup([newPrimary, ...bindings.slice(1)]);
  }

  function addMember(): void {
    if (!primary || bindings.length >= MAX_COMBINED_BERTH_MEMBERS) return;
    const newMember: TdBerthBinding = {
      id: `bind-${elementId}-${bindings.length + 1}-${Date.now()}`,
      elementId,
      type: "tdBerth",
      tdArea: primary.tdArea,
      berth: "",
      allowDuplicate: false,
    };
    commitGroup([...bindings, newMember]);
  }

  function updateMember(index: number, tdArea: string, berth: string): void {
    commitGroup(bindings.map((b, i) => (i === index ? { ...b, tdArea, berth } : b)));
  }

  function removeMember(index: number): void {
    commitGroup(bindings.filter((_, i) => i !== index));
  }

  return (
    <fieldset>
      <legend>TD binding</legend>
      <label className="field">
        TD area
        <input
          list="observed-td-areas"
          value={localArea}
          onChange={(e) => setLocalArea(e.target.value)}
          onBlur={() => commitBinding(localArea, localBerth)}
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
          value={localBerth}
          onChange={(e) => setLocalBerth(e.target.value)}
          onBlur={() => commitBinding(localArea, localBerth)}
        />
        <datalist id="observed-berths">
          {berths.map((berth) => (
            <option key={berth} value={berth} />
          ))}
        </datalist>
      </label>
      {primary ? (
        <button type="button" className="btn" onClick={() => commitGroup([])}>
          Clear binding
        </button>
      ) : null}

      {bindings.length > 1 ? (
        <>
          <p className="field-hint">
            Combined berth: up to {MAX_COMBINED_BERTH_MEMBERS} physical berths sharing this one box
            (a split-berth group used for permissive working, with no room to draw each member
            separately). Occupied members display joined in this order, e.g. &quot;A001 B001&quot;.
          </p>
          {bindings.slice(1).map((member, i) => (
            <CombinedMemberRow
              key={member.id}
              member={member}
              onCommit={(tdArea, berth) => updateMember(i + 1, tdArea, berth)}
              onRemove={() => removeMember(i + 1)}
            />
          ))}
        </>
      ) : null}
      {primary && bindings.length < MAX_COMBINED_BERTH_MEMBERS ? (
        <button type="button" className="btn" onClick={addMember}>
          + Combine with another berth
        </button>
      ) : null}
    </fieldset>
  );
}

/** A layer dropdown reused by both the single-element and multi-selection views — sorted by
 * `order` so it reads top-to-bottom in actual paint order, not document/creation order. */
function LayerSelect({
  layers,
  value,
  placeholder,
  onChange,
}: {
  layers: MapDocument["layers"];
  value: string;
  placeholder?: string;
  onChange: (layerId: string) => void;
}): JSX.Element {
  const sorted = [...layers].sort((a, b) => a.order - b.order);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {sorted.map((layer) => (
        <option key={layer.id} value={layer.id}>
          {layer.name}
        </option>
      ))}
    </select>
  );
}

/** docs/MAP_EDITOR_SPEC.md §6: "Right properties/binding/validation panel." Shows editable
 * fields for exactly one selected element. Multi-selection gets one bulk action — reassign every
 * selected element to a single layer — added specifically to recover from the real production
 * bug where every tool defaulted new elements to the document's first layer regardless of type
 * (see EditorCanvas.tsx's defaultLayerIdForTool): a hand-authored map ended up with ~50 elements
 * needing their layer corrected, which one-at-a-time editing would make painfully slow. Other
 * bulk property editing stays out of scope for this pass, same as before. */
export function PropertyPanel(): JSX.Element {
  const { document: doc, selection } = useEditorState();
  const dispatch = useEditorDispatch();

  if (selection.length !== 1) {
    if (selection.length === 0) {
      return (
        <aside aria-label="Properties" className="panel-card">
          <h3>Properties</h3>
          <fieldset>
            <legend>Map</legend>
            <TextField
              label="Name (shown as the map heading)"
              value={doc.map.name}
              onCommit={(name) => dispatch({ type: "setMapName", name })}
            />
            <p className="field-hint">
              Home point — where the public map centres for a visitor with no remembered view yet
              (e.g. clicking this map from the home page). Leave unset to use the map&apos;s plain
              bounding-box centre instead.
            </p>
            <NumberField
              label="Home point X"
              value={doc.map.homePoint?.x ?? 0}
              onCommit={(x) =>
                dispatch({
                  type: "setMapHomePoint",
                  point: { x, y: doc.map.homePoint?.y ?? 0 },
                })
              }
            />
            <NumberField
              label="Home point Y"
              value={doc.map.homePoint?.y ?? 0}
              onCommit={(y) =>
                dispatch({
                  type: "setMapHomePoint",
                  point: { x: doc.map.homePoint?.x ?? 0, y },
                })
              }
            />
            {doc.map.homePoint ? (
              <button
                type="button"
                className="btn"
                onClick={() => dispatch({ type: "setMapHomePoint", point: null })}
              >
                Clear home point
              </button>
            ) : null}
          </fieldset>
          <p className="panel-card--empty">Select an element to edit it.</p>
        </aside>
      );
    }
    return (
      <aside aria-label="Properties" className="panel-card">
        <h3>Properties</h3>
        <p className="panel-card--empty">{selection.length} elements selected.</p>
        <label className="field">
          Move to layer
          <LayerSelect
            layers={doc.layers}
            value=""
            placeholder="Choose a layer…"
            onChange={(layerId) => {
              for (const elementId of selection) {
                dispatch({
                  type: "dispatchCommand",
                  command: { type: "setProperty", elementId, property: "layerId", value: layerId },
                });
              }
            }}
          />
        </label>
      </aside>
    );
  }

  const elementId = selection[0]!;
  const element = doc.elements.find((el) => el.id === elementId);
  if (!element) {
    return <aside aria-label="Properties" className="panel-card" />;
  }
  const bindings = doc.bindings
    .filter((b): b is TdBerthBinding => b.type === "tdBerth" && b.elementId === elementId)
    .sort((a, b) => (a.combinedOrder ?? 1) - (b.combinedOrder ?? 1));

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
      <label className="field">
        Layer
        <LayerSelect
          layers={doc.layers}
          value={element.layerId}
          onChange={(layerId) => setProp("layerId", layerId)}
        />
      </label>
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

      <div className="field-row">
        <NumberField
          label="Z-index"
          value={element.zIndex}
          onCommit={(v) => setProp("zIndex", Math.round(v))}
        />
        <div className="btn-group">
          <button
            type="button"
            className="btn"
            aria-label="Decrease Z-index"
            onClick={() => setProp("zIndex", element.zIndex - 1)}
          >
            −
          </button>
          <button
            type="button"
            className="btn"
            aria-label="Increase Z-index"
            onClick={() => setProp("zIndex", element.zIndex + 1)}
          >
            +
          </button>
        </div>
      </div>
      <p className="field-hint">
        0 = this layer&apos;s default position (tracks &lt; berths &lt; signals &lt; everything
        else). ± nudges reorder within the layer; a value ±{Z_INDEX_LAYER_BAND.toLocaleString()} or
        more deliberately overrides the layer order (e.g. sinks a signal below a berth).
      </p>

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
          <label className="field">
            Station
            <select
              value={element.stationId ?? ""}
              onChange={(e) => setProp("stationId", e.target.value || undefined)}
            >
              <option value="">(none)</option>
              {doc.elements
                .filter((el) => el.type === "station")
                .map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.type === "station" ? el.name : el.id}
                  </option>
                ))}
            </select>
          </label>
          <TextField
            label="Station CRS"
            value={element.crs ?? ""}
            onCommit={(v) => setProp("crs", v ? v.toUpperCase() : undefined)}
          />
          <label className="field">
            Inhibited by
            <select
              value={element.inhibitedBy ?? ""}
              onChange={(e) => setProp("inhibitedBy", e.target.value || undefined)}
            >
              <option value="">(none)</option>
              {doc.elements
                .filter((el): el is typeof element => el.type === "berth" && el.id !== elementId)
                .map((el) => {
                  // Show "PX CE04" (TD area + berth) rather than just the 4-char displayName,
                  // which is ambiguous — the whole point of this field is picking apart two
                  // berths that likely share the same displayed description.
                  const elBinding = doc.bindings.find((b) => b.elementId === el.id);
                  const label =
                    elBinding?.type === "tdBerth"
                      ? `${elBinding.tdArea} ${elBinding.berth}`
                      : `${el.displayName} (unbound)`;
                  return (
                    <option key={el.id} value={el.id}>
                      {label}
                    </option>
                  );
                })}
            </select>
          </label>
          <p className="field-hint">
            Opt-in TD-area fringe pair: when the selected berth currently shows the same description
            as this one, this berth renders blank on the live map — cosmetic only, both berths keep
            their real recorded state.
          </p>
          <BindingFields elementId={elementId} bindings={bindings} />
        </>
      )}

      {element.type === "station" && (
        <>
          <TextField label="Name" value={element.name} onCommit={(v) => setProp("name", v)} />
          <TextField
            label="CRS"
            value={element.crs ?? ""}
            onCommit={(v) => setProp("crs", v ? v.toUpperCase() : undefined)}
          />
          <TextField
            label="TIPLOC"
            value={element.tiploc ?? ""}
            onCommit={(v) => setProp("tiploc", v || undefined)}
          />
          <TextField
            label="STANOX"
            value={element.stanox ?? ""}
            onCommit={(v) => setProp("stanox", v || undefined)}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <NumberField
            label="Font size"
            value={element.fontSize}
            onCommit={(v) => setProp("fontSize", v)}
          />
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
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={element.renderMode === "offset"}
              onChange={(e) => setProp("renderMode", e.target.checked ? "offset" : "inline")}
            />
            Offset style (stem + head off the track)
          </label>
        </>
      )}

      {element.type === "label" && (
        <>
          <TextField
            label="Text (newlines wrap)"
            value={element.text}
            multiline
            onCommit={(v) => setProp("text", v)}
          />
          <label className="field">
            Align
            <select value={element.align} onChange={(e) => setProp("align", e.target.value)}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <NumberField
            label="Font size"
            value={element.fontSize}
            onCommit={(v) => setProp("fontSize", v)}
          />
          <TextField
            label="CRS"
            value={element.crs ?? ""}
            onCommit={(v) => setProp("crs", v ? v.toUpperCase() : undefined)}
          />
          <TextField
            label="TIPLOC"
            value={element.tiploc ?? ""}
            onCommit={(v) => setProp("tiploc", v || undefined)}
          />
          <TextField
            label="STANOX"
            value={element.stanox ?? ""}
            onCommit={(v) => setProp("stanox", v || undefined)}
          />
          <p className="field-hint">
            Optional place identifiers (Milestone 31) — set any of these to make this label findable
            by name/CRS/TIPLOC/STANOX from the landing page&apos;s place search.
          </p>
          <TextField
            label="Adjacent map slug"
            value={element.adjacentMapSlug ?? ""}
            onCommit={(v) => setProp("adjacentMapSlug", v || undefined)}
          />
          <TextField
            label="Adjacent boundary name"
            value={element.adjacentBoundaryName ?? ""}
            onCommit={(v) => setProp("adjacentBoundaryName", v || undefined)}
          />
          <p className="field-hint">
            Milestone 32: set Adjacent map slug to make this label a clickable boundary link on the
            public map — jumps to that map centred on its own same-boundary label. Adjacent boundary
            name is what this same boundary is called *there*, often different from this
            label&apos;s own Text above since each side is usually named from its own perspective
            (e.g. this side reads &quot;Carlisle PSB&quot; while the far side reads &quot;Preston
            PSB&quot; for the identical crossing) — leave blank only if the two sides genuinely
            share a name.
          </p>
        </>
      )}

      {element.type === "boundary" && (
        <>
          <p className="field-hint">
            Legacy element — superseded 2026-09-13 by a Label with an Adjacent map slug set (see the
            Label fields above). Editable here only so an already-published boundary from an older
            map version isn&apos;t stranded; not offered as a tool for new elements.
          </p>
          <TextField label="Name" value={element.name} onCommit={(v) => setProp("name", v)} />
          <TextField
            label="Adjacent map slug"
            value={element.adjacentMapSlug ?? ""}
            onCommit={(v) => setProp("adjacentMapSlug", v || undefined)}
          />
          <TextField
            label="Adjacent boundary name"
            value={element.adjacentBoundaryName ?? ""}
            onCommit={(v) => setProp("adjacentBoundaryName", v || undefined)}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
        </>
      )}

      {element.type === "platform" && (
        <>
          <TextField
            label="Name"
            value={element.name ?? ""}
            onCommit={(v) => setProp("name", v || undefined)}
          />
          <p className="field-hint">
            A filled shape — double-click an edge to add a corner, double-click a corner handle to
            remove it, drag corners to vary the width. Platform numbers are a separate item (Plat.
            number tool).
          </p>
        </>
      )}

      {element.type === "platformNumber" && (
        <>
          <TextField label="Text" value={element.text} onCommit={(v) => setProp("text", v)} />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <NumberField
            label="Font size"
            value={element.fontSize}
            onCommit={(v) => setProp("fontSize", v)}
          />
          <label className="field">
            Platform
            <select
              value={element.platformId ?? ""}
              onChange={(e) => setProp("platformId", e.target.value || undefined)}
            >
              <option value="">(none)</option>
              {doc.elements
                .filter((el) => el.type === "platform")
                .map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.type === "platform" && el.name ? el.name : el.id}
                  </option>
                ))}
            </select>
          </label>
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
