import { useEffect, useState } from "react";
import {
  MAP_STYLE,
  Z_INDEX_LAYER_BAND,
  canonicalSAddress,
  levelCrossingGeometry,
  neutralSectionGeometry,
  placedLabelAnchor,
  pointsBounds,
  routeWarnings,
  scaleShapeWidth,
  switchedDiamondGeometry,
  viaductWidth,
  type MapDocument,
  type RouteElement,
  type TdSBitRouteBinding,
  type TdBerthBinding,
  type TdSBitBarrierBinding,
  type TdSBitBarrierInferredBinding,
  type TdSBitBinding,
} from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import {
  useObservedAreas,
  useObservedBerths,
  useSClassAreas,
  useSClassDefinitions,
} from "./useBindingAutocomplete.js";
import { routeDisplayName } from "./routeTrace.js";

const MAX_COMBINED_BERTH_MEMBERS = 4;

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  /** Render a resizable textarea instead of a single-line input — for text that can span
   * multiple lines (each newline wraps in both renderers): a `label`'s text, and since
   * 2026-09-20 a `station`'s name. */
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
  /** Inclusive lower bound, for a field the schema itself constrains (e.g. a positive board
   * size). An entry below it is refused and the input snaps back to the stored value, rather
   * than leaving the field showing a number the document never actually took. */
  min?: number;
}

function NumberField({ label, value, onCommit, min }: NumberFieldProps): JSX.Element {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <label className="field">
      {label}
      <input
        type="number"
        {...(min === undefined ? {} : { min })}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const parsed = Number(local);
          if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
            setLocal(String(value));
            return;
          }
          if (parsed !== value) onCommit(parsed);
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
    <div className="field-row field-row--combined-member">
      {/* `.field` (not a `<label>`) — a plain field's visible "TD area"/"Berth" text is
          identical to this row's, and getByLabelText matches on wrapping-label text regardless
          of a differing aria-label, so two real <label>s reading the same thing would collide.
          A <div> gets the exact same box/spacing styling (the CSS targets `.field input`, not
          specifically a <label>) without an implicit label association — this input's only
          accessible name is its aria-label. */}
      <div className="field">
        <span aria-hidden="true">TD area</span>
        <input
          aria-label={`Combined member ${member.combinedOrder ?? ""} TD area`}
          list="observed-td-areas"
          value={area}
          onChange={(e) => setArea(e.target.value)}
          onBlur={commit}
        />
      </div>
      <div className="field">
        <span aria-hidden="true">Berth</span>
        <input
          aria-label={`Combined member ${member.combinedOrder ?? ""} berth`}
          list={`observed-berths-${member.id}`}
          value={berth}
          onChange={(e) => setBerth(e.target.value)}
          onBlur={commit}
        />
      </div>
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

/**
 * Milestone 55: the label controls every piece of map furniture shares — caption, which side it
 * attaches to, and detach/reattach with a free offset (owner request 2026-09-20, generalised
 * here from the neutral-section-only version). One component so a tunnel, viaduct, water body,
 * neutral section and level crossing all label the same way.
 *
 * `detachAt` is where the label currently *is*, in element-local offset terms — the caller works
 * it out from the element's own geometry so that clicking "Detach label" never makes the label
 * jump. It is deliberately not rounded: rounding for a tidier field left a left/right detach half
 * a unit off, which defeats the point.
 */
function PlacedLabelFieldset({
  label,
  labelPosition,
  labelOffset,
  fontSize,
  detachAt,
  setProp,
}: {
  label: string | undefined;
  labelPosition: "above" | "below" | "left" | "right";
  labelOffset: { x: number; y: number } | undefined;
  fontSize: number;
  detachAt: () => { x: number; y: number };
  setProp: (property: string, value: unknown) => void;
}): JSX.Element {
  return (
    <>
      <TextField
        label="Label"
        value={label ?? ""}
        onCommit={(v) => setProp("label", v || undefined)}
      />
      {labelOffset === undefined ? (
        <>
          <label className="field">
            Label position
            <select
              value={labelPosition}
              onChange={(e) => setProp("labelPosition", e.target.value)}
            >
              <option value="above">above</option>
              <option value="below">below</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
          </label>
          <button type="button" className="btn" onClick={() => setProp("labelOffset", detachAt())}>
            Detach label
          </button>
        </>
      ) : (
        <>
          <p className="field-hint">
            Label detached — drag it on the canvas, or set its offset from the shape&apos;s centre
            below. It still moves with the shape.
          </p>
          <NumberField
            label="Label offset X"
            value={labelOffset.x}
            onCommit={(v) => setProp("labelOffset", { ...labelOffset, x: v })}
          />
          <NumberField
            label="Label offset Y"
            value={labelOffset.y}
            onCommit={(v) => setProp("labelOffset", { ...labelOffset, y: v })}
          />
          <button type="button" className="btn" onClick={() => setProp("labelOffset", undefined)}>
            Reattach label
          </button>
        </>
      )}
      <NumberField label="Font size" value={fontSize} onCommit={(v) => setProp("fontSize", v)} />
    </>
  );
}

/**
 * Milestone 55 / ADR 0014: bind a level crossing's barriers to one S-Class bit. Deliberately a
 * separate, simpler control from `SignalBindingFields` — it speaks the barrier's own up/down
 * vocabulary, so an author never has to think of a barrier in signal terms, and it has no
 * signal-definition lookup.
 *
 * Same discipline as a signal binding (ADR 0013): `activeMeans` is verified per crossing and
 * never assumed, and the displayed position is always and only this bit's value — never derived
 * from train movements, routes or timetables (CLAUDE.md rule 10). An unbound crossing shows grey
 * barriers, which means "no information", not "up".
 */
function BarrierBindingFields({
  elementId,
  binding,
}: {
  elementId: string;
  binding: TdSBitBarrierBinding | undefined;
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const areas = useSClassAreas();
  const [area, setArea] = useState(binding?.tdArea ?? "");
  const [address, setAddress] = useState(binding?.address ?? "");
  const [bit, setBit] = useState(binding ? String(binding.bit) : "");
  const [activeMeans, setActiveMeans] = useState<"up" | "down">(binding?.activeMeans ?? "down");
  useEffect(() => {
    setArea(binding?.tdArea ?? "");
    setAddress(binding?.address ?? "");
    setBit(binding ? String(binding.bit) : "");
    setActiveMeans(binding?.activeMeans ?? "down");
  }, [elementId, binding]);

  const areaCode = area.trim().toUpperCase();
  const canonical = /^[0-9A-Fa-f]{1,2}$/.test(address.trim())
    ? canonicalSAddress(address.trim())
    : null;
  const bitNumber = /^[0-7]$/.test(bit.trim()) ? Number(bit.trim()) : null;
  const valid = /^[A-Z0-9]{2}$/.test(areaCode) && canonical !== null && bitNumber !== null;

  function apply(): void {
    if (!valid || canonical === null || bitNumber === null) return;
    const next: TdSBitBarrierBinding = {
      id: binding?.id ?? `bind-${elementId}-barrier-${Date.now()}`,
      elementId,
      type: "tdSBitBarrier",
      tdArea: areaCode,
      address: canonical,
      bit: bitNumber,
      activeMeans,
    };
    dispatch({
      type: "dispatchCommand",
      command: { type: "setBinding", elementId, binding: next },
    });
  }

  return (
    <fieldset>
      <legend>Barrier S-Class binding</legend>
      <label className="field">
        TD area
        <input
          list="s-class-areas-barrier"
          value={area}
          onChange={(e) => setArea(e.target.value.toUpperCase())}
        />
        <datalist id="s-class-areas-barrier">
          {areas.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>
      <label className="field">
        Address (hex)
        <input value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <label className="field">
        Bit (0-7)
        <input value={bit} onChange={(e) => setBit(e.target.value)} />
      </label>
      <label className="field">
        Bit set means
        <select
          value={activeMeans}
          onChange={(e) => setActiveMeans(e.target.value === "up" ? "up" : "down")}
        >
          <option value="down">barriers down</option>
          <option value="up">barriers up</option>
        </select>
      </label>
      <button type="button" className="btn btn--primary" disabled={!valid} onClick={apply}>
        {binding ? "Update binding" : "Bind barriers"}
      </button>
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
      <p className="field-hint">
        The crossing shows only this bit: barriers raised or lowered (in schematic style, green =
        up, red = down, grey = unknown). Unknown — a stale bit or a feed gap — is drawn lowered in
        the realistic style. Verify what the bit actually means for this crossing before binding it.
      </p>
    </fieldset>
  );
}

type BarrierSource = "none" | "bit" | "inferred";

/**
 * Milestone 59 / ADR 0015: where a level crossing's barrier position comes from — nothing (drawn
 * lowered), a direct S-Class crossing (LXC) bit, or a rule inferred from its protecting signals.
 * A crossing has exactly one source or none; applying either form replaces whatever was there
 * (`setBinding` swaps every binding on the element), so they can never coexist.
 */
function BarrierSourceFields({
  elementId,
  binding,
}: {
  elementId: string;
  binding: TdSBitBarrierBinding | TdSBitBarrierInferredBinding | undefined;
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const stored: BarrierSource =
    binding?.type === "tdSBitBarrier"
      ? "bit"
      : binding?.type === "tdSBitBarrierInferred"
        ? "inferred"
        : "none";
  // The picker can move ahead of the document — choosing a source only shows its form; nothing is
  // committed until that form is applied — except "Not driven", which clears at once (undoable).
  const [source, setSource] = useState<BarrierSource>(stored);
  useEffect(() => setSource(stored), [elementId, stored]);

  return (
    <>
      <label className="field">
        Barrier position
        <select
          value={source}
          onChange={(e) => {
            const next = e.target.value as BarrierSource;
            setSource(next);
            if (next === "none" && binding) {
              dispatch({
                type: "dispatchCommand",
                command: { type: "setBinding", elementId, binding: null },
              });
            }
          }}
        >
          <option value="none">Not driven — always shown lowered</option>
          <option value="bit">S-Class crossing bit</option>
          <option value="inferred">Inferred from protecting signals</option>
        </select>
      </label>
      {source === "none" ? (
        <p className="field-hint">
          For an area with no S-Class coverage: the barriers are always drawn lowered, which says
          nothing about where they really are.
        </p>
      ) : null}
      {source === "bit" ? (
        <BarrierBindingFields
          elementId={elementId}
          binding={binding?.type === "tdSBitBarrier" ? binding : undefined}
        />
      ) : null}
      {source === "inferred" ? (
        <InferredBarrierFields
          elementId={elementId}
          binding={binding?.type === "tdSBitBarrierInferred" ? binding : undefined}
        />
      ) : null}
    </>
  );
}

interface InferredInputRow {
  tdArea: string;
  address: string;
  bit: string;
  activeMeans: "on" | "off";
  label: string;
}

const MAX_INFERRED_INPUTS = 6;

function emptyInferredRow(): InferredInputRow {
  return { tdArea: "", address: "", bit: "", activeMeans: "off", label: "" };
}

function inferredRowsFrom(binding: TdSBitBarrierInferredBinding | undefined): InferredInputRow[] {
  if (!binding) return [emptyInferredRow(), emptyInferredRow()];
  return binding.inputs.map((input) => ({
    tdArea: input.tdArea,
    address: input.address,
    bit: String(input.bit),
    activeMeans: input.activeMeans,
    label: input.label ?? "",
  }));
}

function inferredRowValid(row: InferredInputRow): boolean {
  return (
    /^[A-Z0-9]{2}$/.test(row.tdArea.trim().toUpperCase()) &&
    /^[0-9A-Fa-f]{1,2}$/.test(row.address.trim()) &&
    /^[0-7]$/.test(row.bit.trim())
  );
}

/**
 * Milestone 59 / ADR 0015: a crossing inferred from the signals protecting it, for an area whose
 * feed publishes signals but no crossing bit. Each row is one signal's bit and what a set bit
 * means for *that signal* — verified per input, as for a signal binding. The rule itself is fixed
 * (`inferredBarrierState`): lowered if any is off, raised only if every one is confirmed on.
 * Typically two rows, one per direction. Applied with one explicit button so a half-filled form
 * never commits a wrong rule.
 */
function InferredBarrierFields({
  elementId,
  binding,
}: {
  elementId: string;
  binding: TdSBitBarrierInferredBinding | undefined;
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const areas = useSClassAreas();
  const [rows, setRows] = useState<InferredInputRow[]>(() => inferredRowsFrom(binding));
  useEffect(() => setRows(inferredRowsFrom(binding)), [elementId, binding]);

  const valid = rows.length > 0 && rows.every(inferredRowValid);
  const update = (index: number, patch: Partial<InferredInputRow>): void =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  function apply(): void {
    if (!valid) return;
    const next: TdSBitBarrierInferredBinding = {
      id: binding?.id ?? `bind-${elementId}-inferred-${Date.now()}`,
      elementId,
      type: "tdSBitBarrierInferred",
      inputs: rows.map((row) => ({
        tdArea: row.tdArea.trim().toUpperCase(),
        address: canonicalSAddress(row.address.trim()),
        bit: Number(row.bit.trim()),
        activeMeans: row.activeMeans,
        ...(row.label.trim() ? { label: row.label.trim() } : {}),
      })),
    };
    dispatch({
      type: "dispatchCommand",
      command: { type: "setBinding", elementId, binding: next },
    });
  }

  return (
    <fieldset>
      <legend>Inferred from protecting signals</legend>
      <datalist id="s-class-areas-inferred">
        {areas.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      {rows.map((row, i) => (
        <div key={i} className="field-row">
          {/* `.field` divs rather than <label>s: every row repeats the same visible text, and each
              input's accessible name is its row-specific aria-label (see CombinedMemberRow). */}
          <div className="field">
            <span aria-hidden="true">Signal</span>
            <input
              aria-label={`Input ${i + 1} signal name`}
              value={row.label}
              placeholder="e.g. S3879"
              onChange={(e) => update(i, { label: e.target.value })}
            />
          </div>
          <div className="field">
            <span aria-hidden="true">TD area</span>
            <input
              aria-label={`Input ${i + 1} TD area`}
              list="s-class-areas-inferred"
              value={row.tdArea}
              onChange={(e) => update(i, { tdArea: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="field">
            <span aria-hidden="true">Address (hex)</span>
            <input
              aria-label={`Input ${i + 1} address`}
              value={row.address}
              onChange={(e) => update(i, { address: e.target.value })}
            />
          </div>
          <div className="field">
            <span aria-hidden="true">Bit (0-7)</span>
            <input
              aria-label={`Input ${i + 1} bit`}
              value={row.bit}
              onChange={(e) => update(i, { bit: e.target.value })}
            />
          </div>
          <div className="field">
            <span aria-hidden="true">Bit set means</span>
            <select
              aria-label={`Input ${i + 1} bit set means`}
              value={row.activeMeans}
              onChange={(e) => update(i, { activeMeans: e.target.value === "on" ? "on" : "off" })}
            >
              <option value="off">signal off (proceed)</option>
              <option value="on">signal on (danger)</option>
            </select>
          </div>
          {rows.length > 1 ? (
            <button
              type="button"
              className="btn"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {rows.length < MAX_INFERRED_INPUTS ? (
        <button
          type="button"
          className="btn"
          onClick={() => setRows((prev) => [...prev, emptyInferredRow()])}
        >
          + Add signal
        </button>
      ) : null}
      <button type="button" className="btn btn--primary" disabled={!valid} onClick={apply}>
        {binding ? "Update rule" : "Apply rule"}
      </button>
      <p className="field-hint">
        Lowered whenever any of these signals is at proceed; raised only when every one is confirmed
        at danger; otherwise unknown, which is drawn lowered. Verify what a set bit means for each
        signal before applying — on M9 a set bit means the signal is off. Signals clear only after
        the barriers are down and return to danger before they rise, so this will show raised for
        part of each cycle while the barriers are really still down.
      </p>
    </fieldset>
  );
}

/**
 * Milestone 36c: bind a signal to one S-Class bit (docs/adr/0013). Pick a defined label for the
 * area (e.g. "S3003") or enter the hex address and bit directly, plus what a set bit means —
 * `activeMeans`, verified per binding (most signal bits are set when the signal is *off*). The
 * signal's shown state is then only ever that bit (CLAUDE.md rules 9/10). Applied with one
 * explicit button so a half-filled form never commits a wrong binding.
 */
function SignalBindingFields({
  elementId,
  binding,
  currentLabel,
  onUseLabel,
}: {
  elementId: string;
  binding: TdSBitBinding | undefined;
  currentLabel: string | undefined;
  onUseLabel: (label: string) => void;
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const areas = useSClassAreas();
  const [area, setArea] = useState(binding?.tdArea ?? "");
  const [address, setAddress] = useState(binding?.address ?? "");
  const [bit, setBit] = useState(binding ? String(binding.bit) : "");
  const [activeMeans, setActiveMeans] = useState<"on" | "off">(binding?.activeMeans ?? "off");
  useEffect(() => {
    setArea(binding?.tdArea ?? "");
    setAddress(binding?.address ?? "");
    setBit(binding ? String(binding.bit) : "");
    setActiveMeans(binding?.activeMeans ?? "off");
  }, [elementId, binding]);

  const areaCode = area.trim().toUpperCase();
  const definitions = useSClassDefinitions(/^[A-Z0-9]{2}$/.test(areaCode) ? areaCode : null);
  const signalDefinitions = definitions.filter((d) => d.kind === "signal" && d.label);
  const canonical = /^[0-9A-Fa-f]{1,2}$/.test(address.trim())
    ? canonicalSAddress(address.trim())
    : null;
  const bitNumber = /^[0-7]$/.test(bit.trim()) ? Number(bit.trim()) : null;
  const matchedDefinition = definitions.find((d) => d.address === canonical && d.bit === bitNumber);
  const valid = /^[A-Z0-9]{2}$/.test(areaCode) && canonical !== null && bitNumber !== null;

  function apply(): void {
    if (!valid || canonical === null || bitNumber === null) return;
    const next: TdSBitBinding = {
      id: binding?.id ?? `bind-${elementId}-s-${Date.now()}`,
      elementId,
      type: "tdSBit",
      tdArea: areaCode,
      address: canonical,
      bit: bitNumber,
      activeMeans,
    };
    dispatch({
      type: "dispatchCommand",
      command: { type: "setBinding", elementId, binding: next },
    });
  }

  return (
    <fieldset>
      <legend>S-Class binding</legend>
      <label className="field">
        TD area
        <input
          list="s-class-areas"
          value={area}
          onChange={(e) => setArea(e.target.value.toUpperCase())}
        />
        <datalist id="s-class-areas">
          {areas.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>
      {signalDefinitions.length > 0 ? (
        <label className="field">
          Defined signal
          <select
            value={matchedDefinition ? `${matchedDefinition.address}:${matchedDefinition.bit}` : ""}
            onChange={(e) => {
              const [a, b] = e.target.value.split(":");
              if (a && b) {
                setAddress(a);
                setBit(b);
              }
            }}
          >
            <option value="">— choose —</option>
            {signalDefinitions.map((d) => (
              <option key={`${d.address}:${d.bit}`} value={`${d.address}:${d.bit}`}>
                {d.label} ({d.address}:{d.bit})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        Address (hex)
        <input value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <label className="field">
        Bit (0-7)
        <input value={bit} onChange={(e) => setBit(e.target.value)} />
      </label>
      <label className="field">
        A set bit means
        <select
          value={activeMeans}
          onChange={(e) => setActiveMeans(e.target.value === "on" ? "on" : "off")}
        >
          <option value="off">off (green) — usual for signal bits</option>
          <option value="on">on (red)</option>
        </select>
      </label>
      {matchedDefinition?.label ? (
        <p className="field-hint">
          Defined as {matchedDefinition.label}
          {matchedDefinition.label !== currentLabel ? (
            <>
              {" "}
              <button
                type="button"
                className="btn"
                onClick={() => onUseLabel(matchedDefinition.label ?? "")}
              >
                Use as label
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <button type="button" className="btn btn--primary" disabled={!valid} onClick={apply}>
        {binding ? "Update binding" : "Bind signal"}
      </button>
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
      <p className="field-hint">
        The signal shows only this bit: red = on, green = off, grey = blank (unknown or feed gap). A
        dashed ring on the canvas means it is showing live state.
      </p>
    </fieldset>
  );
}

/**
 * Milestone 63 (revised 2026-09-22): a switched diamond's mark and which corners are switched. The
 * angle comes from the tracks it sits on, so there is nothing to rotate or size.
 */
function SwitchedDiamondFields({
  x,
  y,
  corners,
  markStyle,
  setProp,
}: {
  x: number;
  y: number;
  corners: Array<"a" | "b">;
  markStyle: "knuckle" | "ticks";
  setProp: (property: string, value: unknown) => void;
}): JSX.Element {
  const { document: doc } = useEditorState();
  const onCrossing =
    switchedDiamondGeometry(
      { x, y, corners, style: markStyle },
      doc.elements.filter((element) => element.type === "trackPath"),
    ) !== null;
  const toggle = (corner: "a" | "b", on: boolean): void => {
    const next = on ? [...new Set([...corners, corner])] : corners.filter((c) => c !== corner);
    // At least one corner is switched, or it would just be a plain diamond with no marker.
    if (next.length > 0) setProp("corners", next.sort());
  };
  return (
    <>
      {onCrossing ? null : (
        <p className="badge badge--warning">
          Not on a crossing of two tracks, so nothing is drawn. Drag it onto the crossing — it snaps
          there.
        </p>
      )}
      <label className="field">
        Style
        <select
          value={markStyle}
          onChange={(e) => setProp("style", e.target.value === "ticks" ? "ticks" : "knuckle")}
        >
          <option value="knuckle">Filled knuckle</option>
          <option value="ticks">Blade ticks</option>
        </select>
      </label>
      <fieldset>
        <legend>Switched corners</legend>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={corners.includes("a")}
            onChange={(e) => toggle("a", e.target.checked)}
          />
          Upper corner
        </label>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={corners.includes("b")}
            onChange={(e) => toggle("b", e.target.checked)}
          />
          Lower corner
        </label>
      </fieldset>
      <p className="field-hint">
        The blades sit in the crossing's two obtuse corners; tick the one(s) that are switched. The
        mark takes its angle from the tracks, so it follows them if they move. Display only: no
        binding, and it says nothing about which way the blades lie.
      </p>
    </>
  );
}

/**
 * Milestone 64 / ADR 0016 decision 3: the routes that start at this signal, authored from here.
 * "Add route" starts a trace on the canvas from this signal.
 */
function SignalRoutesFieldset({ signalId }: { signalId: string }): JSX.Element {
  const { document: doc } = useEditorState();
  const dispatch = useEditorDispatch();
  const routes = doc.elements.filter(
    (element): element is RouteElement =>
      element.type === "route" && element.entrySignalId === signalId,
  );
  const boundIds = new Set(
    doc.bindings.filter((b) => b.type === "tdSBitRoute").map((b) => b.elementId),
  );
  return (
    <fieldset>
      <legend>Routes from this signal</legend>
      {routes.length === 0 ? (
        <p className="field-hint">No routes yet.</p>
      ) : (
        <ul className="route-list">
          {routes.map((route) => (
            <li key={route.id}>
              <button
                type="button"
                className="btn btn--link"
                onClick={() => dispatch({ type: "setSelection", ids: [route.id] })}
              >
                {routeDisplayName(doc, route)}
              </button>
              {boundIds.has(route.id) ? null : <span className="badge badge--warning">no bit</span>}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn"
        onClick={() => dispatch({ type: "startRouteTrace", signalId })}
      >
        Add route
      </button>
      <p className="field-hint">
        Routes from this signal are drawn on the canvas while it is selected. Add route, then click
        along the track in the direction the route runs and click the exit signal.
      </p>
    </fieldset>
  );
}

/** Milestone 64 / ADR 0016 decision 1: the one S-Class bit that says whether this route is set,
 * with the author's statement of what a set bit means. Same shape as a signal's binding, in the
 * route's own set/unset vocabulary; the TD area defaults to the entry signal's. */
function RouteBindingFields({
  route,
  binding,
  defaultArea,
}: {
  route: RouteElement;
  binding: TdSBitRouteBinding | undefined;
  defaultArea: string;
}): JSX.Element {
  const dispatch = useEditorDispatch();
  const areas = useSClassAreas();
  const [area, setArea] = useState(binding?.tdArea ?? defaultArea);
  const [address, setAddress] = useState(binding?.address ?? "");
  const [bit, setBit] = useState(binding ? String(binding.bit) : "");
  const [activeMeans, setActiveMeans] = useState<"set" | "unset">(binding?.activeMeans ?? "set");
  useEffect(() => {
    setArea(binding?.tdArea ?? defaultArea);
    setAddress(binding?.address ?? "");
    setBit(binding ? String(binding.bit) : "");
    setActiveMeans(binding?.activeMeans ?? "set");
  }, [route.id, binding, defaultArea]);

  const areaCode = area.trim().toUpperCase();
  const definitions = useSClassDefinitions(/^[A-Z0-9]{2}$/.test(areaCode) ? areaCode : null);
  const routeDefinitions = definitions.filter((d) => d.kind === "route" && d.label);
  const canonical = /^[0-9A-Fa-f]{1,2}$/.test(address.trim())
    ? canonicalSAddress(address.trim())
    : null;
  const bitNumber = /^[0-7]$/.test(bit.trim()) ? Number(bit.trim()) : null;
  const matchedDefinition = definitions.find((d) => d.address === canonical && d.bit === bitNumber);
  const valid = /^[A-Z0-9]{2}$/.test(areaCode) && canonical !== null && bitNumber !== null;

  function apply(): void {
    if (!valid || canonical === null || bitNumber === null) return;
    const next: TdSBitRouteBinding = {
      id: binding?.id ?? `bind-${route.id}-r-${Date.now()}`,
      elementId: route.id,
      type: "tdSBitRoute",
      tdArea: areaCode,
      address: canonical,
      bit: bitNumber,
      activeMeans,
    };
    dispatch({
      type: "dispatchCommand",
      command: { type: "setBinding", elementId: route.id, binding: next },
    });
    // Owner request 2026-09-22: an unnamed route takes the bit's label from the S-Class
    // definitions (e.g. "R111AM") as its name. A name the author already gave is never replaced.
    if (!route.label && matchedDefinition?.label) {
      dispatch({
        type: "dispatchCommand",
        command: {
          type: "setProperty",
          elementId: route.id,
          property: "label",
          value: matchedDefinition.label,
        },
      });
    }
  }

  return (
    <fieldset>
      <legend>Route bit</legend>
      <label className="field">
        TD area
        <input
          list="s-class-route-areas"
          value={area}
          onChange={(e) => setArea(e.target.value.toUpperCase())}
        />
        <datalist id="s-class-route-areas">
          {areas.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>
      {routeDefinitions.length > 0 ? (
        <label className="field">
          Defined route
          <select
            value={matchedDefinition ? `${matchedDefinition.address}:${matchedDefinition.bit}` : ""}
            onChange={(e) => {
              const [a, b] = e.target.value.split(":");
              if (a && b) {
                setAddress(a);
                setBit(b);
              }
            }}
          >
            <option value="">— choose —</option>
            {routeDefinitions.map((d) => (
              <option key={`${d.address}:${d.bit}`} value={`${d.address}:${d.bit}`}>
                {d.label}
                {d.destination ? ` to ${d.destination}` : ""} ({d.address}:{d.bit})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        Address (hex)
        <input value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <label className="field">
        Bit (0-7)
        <input value={bit} onChange={(e) => setBit(e.target.value)} />
      </label>
      <label className="field">
        A set bit means
        <select
          value={activeMeans}
          onChange={(e) => setActiveMeans(e.target.value === "unset" ? "unset" : "set")}
        >
          <option value="set">the route is set — usual for route bits</option>
          <option value="unset">the route is not set</option>
        </select>
      </label>
      {matchedDefinition?.label ? (
        <p className="field-hint">
          Defined as {matchedDefinition.label}
          {matchedDefinition.destination ? ` to ${matchedDefinition.destination}` : ""}
        </p>
      ) : null}
      <button type="button" className="btn btn--primary" disabled={!valid} onClick={apply}>
        {binding ? "Update binding" : "Bind route"}
      </button>
      {binding ? (
        <button
          type="button"
          className="btn"
          onClick={() =>
            dispatch({
              type: "dispatchCommand",
              command: { type: "setBinding", elementId: route.id, binding: null },
            })
          }
        >
          Clear binding
        </button>
      ) : null}
      <p className="field-hint">
        The route is drawn on the public map only while this bit says it is set — never worked out
        from the signal, train movements or the timetable. Check the bit in the S-Class explorer
        before binding it.
      </p>
    </fieldset>
  );
}

/** Milestone 64: a selected route — its name, ends, where it was traced, and its bit. */
function RouteFields({ route }: { route: RouteElement }): JSX.Element {
  const { document: doc } = useEditorState();
  const dispatch = useEditorDispatch();
  const signalName = (id: string | undefined): string => {
    if (id === undefined) return "none (ends at a boundary or buffer stop)";
    const signal = doc.elements.find((element) => element.id === id);
    return signal?.type === "signal" && signal.label ? `${signal.label} (${id})` : id;
  };
  const warnings = routeWarnings(doc).filter(
    (warning) => warning.elementId === route.id && warning.code !== "route_unbound",
  );
  const entryBinding = doc.bindings.find(
    (b): b is TdSBitBinding => b.type === "tdSBit" && b.elementId === route.entrySignalId,
  );
  return (
    <>
      <TextField
        label="Name (e.g. R3879A)"
        value={route.label ?? ""}
        onCommit={(v) =>
          dispatch({
            type: "dispatchCommand",
            command: {
              type: "setProperty",
              elementId: route.id,
              property: "label",
              value: v || undefined,
            },
          })
        }
      />
      <p className="field-hint">
        From signal{" "}
        <button
          type="button"
          className="btn btn--link"
          onClick={() => dispatch({ type: "setSelection", ids: [route.entrySignalId] })}
        >
          {signalName(route.entrySignalId)}
        </button>{" "}
        to {signalName(route.exitSignalId)}. Traced along {route.trackIds.length} track
        {route.trackIds.length === 1 ? "" : "s"}.
      </p>
      {warnings.map((warning) => (
        <p key={warning.code} className="badge badge--warning">
          {warning.message}
        </p>
      ))}
      <button
        type="button"
        className="btn"
        onClick={() =>
          dispatch({ type: "startRouteTrace", signalId: route.entrySignalId, routeId: route.id })
        }
      >
        Re-trace
      </button>
      <RouteBindingFields
        route={route}
        binding={doc.bindings.find(
          (b): b is TdSBitRouteBinding => b.type === "tdSBitRoute" && b.elementId === route.id,
        )}
        defaultArea={entryBinding?.tdArea ?? ""}
      />
    </>
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
                    {/* A station name can now contain newlines; a dropdown option renders
                        them as a single run of text, so flatten them to spaces here
                        rather than showing words jammed together. */}
                    {el.type === "station" ? el.name.replace(/\s*\n\s*/g, " ") : el.id}
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
          <TextField
            label="Name"
            value={element.name}
            onCommit={(v) => setProp("name", v)}
            multiline
          />
          <p className="field-hint">
            Newlines stack the name into centred lines, the same as a label. A CRS, when set, is
            appended to the last line.
          </p>
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

      {element.type === "neutralSection" && (
        <>
          <PlacedLabelFieldset
            label={element.label}
            labelPosition={element.labelPosition}
            labelOffset={element.labelOffset}
            fontSize={element.fontSize}
            detachAt={() => {
              const geometry = neutralSectionGeometry(element);
              return { x: geometry.label.x - element.x, y: geometry.label.y - element.y };
            }}
            setProp={setProp}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <NumberField
            label="Size"
            value={element.size}
            min={1}
            onCommit={(v) => setProp("size", v)}
          />
          <p className="field-hint">
            Sign AJ02, the neutral section indication board. X/Y is the centre of the board and Size
            is its side in map units, so it scales about the point it sits on — the default{" "}
            {MAP_STYLE.neutralSection.size} is two squares of the default grid, and signs place and
            drag on half-grid steps. Display only: a neutral section carries no binding and no live
            state.
          </p>
        </>
      )}

      {element.type === "switchedDiamond" && (
        <SwitchedDiamondFields
          x={element.x}
          y={element.y}
          // A diamond saved by the first (rhombus) version reaches here as stored, without
          // these; it reads as a knuckle on both corners, as the schema would default it.
          corners={element.corners ?? ["a", "b"]}
          markStyle={element.style ?? "knuckle"}
          setProp={setProp}
        />
      )}

      {element.type === "levelCrossing" && (
        <>
          <PlacedLabelFieldset
            label={element.label}
            labelPosition={element.labelPosition}
            labelOffset={element.labelOffset}
            fontSize={element.fontSize}
            detachAt={() => {
              const geometry = levelCrossingGeometry(element);
              return { x: geometry.label.x - element.x, y: geometry.label.y - element.y };
            }}
            setProp={setProp}
          />
          <NumberField label="X" value={element.x} onCommit={(v) => setProp("x", v)} />
          <NumberField label="Y" value={element.y} onCommit={(v) => setProp("y", v)} />
          <NumberField
            label="Road length (across the track)"
            value={element.roadLength}
            min={1}
            onCommit={(v) => setProp("roadLength", v)}
          />
          <NumberField
            label="Road width (along the track)"
            value={element.roadWidth}
            min={1}
            onCommit={(v) => setProp("roadWidth", v)}
          />
          <NumberField
            label="Orientation (degrees)"
            value={element.orientation}
            onCommit={(v) => setProp("orientation", v)}
          />
          <TextField
            label="Crossing type"
            value={element.crossingType ?? ""}
            onCommit={(v) => setProp("crossingType", v || undefined)}
          />
          <p className="field-hint">
            0° is square across a horizontal track. Crossing type (MCB, AHB, UWC …) is a note to
            yourself — it is never rendered and never affects the barrier display.
          </p>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={element.schematicBarriers === true}
              onChange={(e) => setProp("schematicBarriers", e.target.checked ? true : undefined)}
            />
            Schematic style
          </label>
          <p className="field-hint">
            Crossings are drawn realistically by default — asphalt road with a white centreline,
            red-and-white barriers with a white fence. Tick this for the plain schematic lines
            instead, e.g. where the realistic drawing is too busy.
          </p>
          <BarrierSourceFields
            elementId={elementId}
            binding={doc.bindings.find(
              (b): b is TdSBitBarrierBinding | TdSBitBarrierInferredBinding =>
                (b.type === "tdSBitBarrier" || b.type === "tdSBitBarrierInferred") &&
                b.elementId === elementId,
            )}
          />
        </>
      )}

      {(element.type === "tunnel" || element.type === "water" || element.type === "viaduct") && (
        <>
          <PlacedLabelFieldset
            label={element.label}
            labelPosition={element.labelPosition}
            labelOffset={element.labelOffset}
            fontSize={element.fontSize}
            detachAt={() => {
              const bounds = pointsBounds(element.points);
              const at = placedLabelAnchor(bounds, element);
              return {
                x: at.x - (bounds.x + bounds.width / 2),
                y: at.y - (bounds.y + bounds.height / 2),
              };
            }}
            setProp={setProp}
          />
          {element.type === "viaduct" && (
            <NumberField
              label="Deck width"
              value={viaductWidth(element)}
              min={1}
              onCommit={(v) => setProp("width", v)}
            />
          )}
          {element.type === "tunnel" && (
            <NumberField
              label="Width (across the bore)"
              value={Math.round(pointsBounds(element.points).height * 100) / 100}
              min={1}
              onCommit={(v) => setProp("points", scaleShapeWidth(element.points, v, "y"))}
            />
          )}
          <p className="field-hint">
            {element.type === "viaduct"
              ? "Select it to get endpoint handles: drag them to move or lengthen it, and double-click the line to add a vertex. It paints beneath the rails so the line runs over the deck."
              : "Select it to get corner handles: drag them to reshape, double-click an edge to add a corner, double-click a corner to remove one. Width scales the shape about its own centre, so its length and position stay put. It paints below the track."}{" "}
            Scenery only: no binding and no live state.
          </p>
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
          <SignalBindingFields
            elementId={elementId}
            binding={doc.bindings.find(
              (b): b is TdSBitBinding => b.type === "tdSBit" && b.elementId === elementId,
            )}
            currentLabel={element.label}
            onUseLabel={(label) => setProp("label", label)}
          />
          <SignalRoutesFieldset signalId={elementId} />
        </>
      )}

      {element.type === "route" && <RouteFields route={element} />}

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
