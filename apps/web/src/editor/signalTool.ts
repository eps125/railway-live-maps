import {
  applySignalNamePrefix,
  berthBoxes,
  canonicalSAddress,
  defaultSignalDirection,
  type MapDocument,
  type SignalElement,
} from "@railway/map-schema";

/**
 * ADR 0017 §5: the editor's bulk signal tool. Pure — the dialog fetches the S-Class labels, calls
 * `planSignalTool` for a preview, and applies `plan.patches` as one `patchElements` command.
 */

export interface SignalToolOptions {
  setNames: boolean;
  /** Replaces a label's leading letters (`S001` + `CE` → `CE001`); blank = labels as they are. */
  prefix: string;
  overwriteCustomNames: boolean;
  setDirections: boolean;
  overwriteCustomDirections: boolean;
}

export const DEFAULT_SIGNAL_TOOL_OPTIONS: SignalToolOptions = {
  setNames: true,
  prefix: "",
  overwriteCustomNames: false,
  setDirections: true,
  overwriteCustomDirections: false,
};

export type SignalToolOutcome =
  | { status: "change"; from: string; to: string }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string }
  | { status: "off" };

export interface SignalToolRow {
  elementId: string;
  /** The signal's number as it stands (before the tool), for the preview list. */
  current: string | null;
  name: SignalToolOutcome;
  direction: SignalToolOutcome;
}

export interface SignalToolPlan {
  rows: SignalToolRow[];
  patches: Array<{ elementId: string; patch: Record<string, unknown> }>;
}

/** Key for an S-Class label lookup: `tdArea|ADDRESS|bit` with the address in canonical form. */
export function sClassLabelKey(tdArea: string, address: string, bit: number): string {
  return `${tdArea}|${canonicalSAddress(address)}|${bit}`;
}

const DIRECTION_TEXT = { right: "→ above", left: "← below" } as const;
const REASON_TEXT = {
  "no-berth-nearby": "no berth within 40 on its track",
  "between-two-berths": "exactly between two berths",
  "inside-a-berth": "sits inside a berth box",
} as const;

function describeDirection(signal: SignalElement): string {
  if (!signal.appliesTo) return "not set";
  const side = signal.side ?? (signal.appliesTo === "right" ? "above" : "below");
  return `${signal.appliesTo === "right" ? "→" : "←"} ${side}`;
}

export function planSignalTool(
  doc: MapDocument,
  labels: ReadonlyMap<string, string>,
  options: SignalToolOptions,
): SignalToolPlan {
  const boxes = options.setDirections ? berthBoxes(doc.elements) : [];
  const rows: SignalToolRow[] = [];
  const patches: SignalToolPlan["patches"] = [];

  for (const element of doc.elements) {
    if (element.type !== "signal") continue;
    const patch: Record<string, unknown> = {};

    let name: SignalToolOutcome = { status: "off" };
    if (options.setNames) {
      const binding = doc.bindings.find((b) => b.type === "tdSBit" && b.elementId === element.id);
      // Hand-set: marked so, or a number that predates the tool (no source recorded).
      const handSet =
        element.labelSource === "custom" ||
        (element.labelSource === undefined && Boolean(element.label));
      const sourceLabel =
        binding && binding.type === "tdSBit"
          ? labels.get(sClassLabelKey(binding.tdArea, binding.address, binding.bit))
          : undefined;
      if (!binding) name = { status: "skipped", reason: "not bound to a bit" };
      else if (!sourceLabel) name = { status: "skipped", reason: "its bit has no S-Class label" };
      else if (handSet && !options.overwriteCustomNames) {
        name = { status: "skipped", reason: "number set by hand" };
      } else {
        const next = applySignalNamePrefix(sourceLabel, options.prefix);
        if (next === element.label && element.labelSource === "tool") {
          name = { status: "unchanged" };
        } else {
          name = { status: "change", from: element.label ?? "none", to: next };
          patch.label = next;
          patch.labelSource = "tool";
        }
      }
    }

    let direction: SignalToolOutcome = { status: "off" };
    if (options.setDirections) {
      const handSet =
        element.orientationSource === "custom" ||
        (element.orientationSource === undefined && Boolean(element.appliesTo));
      if (handSet && !options.overwriteCustomDirections) {
        direction = { status: "skipped", reason: "direction set by hand" };
      } else {
        const decision = defaultSignalDirection(element, boxes);
        if (!decision.ok) {
          direction = { status: "skipped", reason: REASON_TEXT[decision.reason] };
        } else if (
          element.appliesTo === decision.appliesTo &&
          (element.side ?? (element.appliesTo === "right" ? "above" : "below")) === decision.side &&
          element.orientationSource === "tool"
        ) {
          direction = { status: "unchanged" };
        } else {
          direction = {
            status: "change",
            from: describeDirection(element),
            to: DIRECTION_TEXT[decision.appliesTo],
          };
          patch.appliesTo = decision.appliesTo;
          patch.side = decision.side;
          patch.orientationSource = "tool";
        }
      }
    }

    rows.push({ elementId: element.id, current: element.label ?? null, name, direction });
    if (Object.keys(patch).length > 0) patches.push({ elementId: element.id, patch });
  }

  return { rows, patches };
}

/** Counts for the preview's summary line. */
export function summariseSignalTool(plan: SignalToolPlan): {
  signals: number;
  namesChanged: number;
  namesSkipped: number;
  directionsChanged: number;
  directionsSkipped: number;
} {
  const count = (pick: (row: SignalToolRow) => SignalToolOutcome, status: string) =>
    plan.rows.filter((row) => pick(row).status === status).length;
  return {
    signals: plan.rows.length,
    namesChanged: count((r) => r.name, "change"),
    namesSkipped: count((r) => r.name, "skipped"),
    directionsChanged: count((r) => r.direction, "change"),
    directionsSkipped: count((r) => r.direction, "skipped"),
  };
}
