import { checkRouteEnds } from "./routeEnds.js";
import {
  applySignalNamePrefix,
  berthBoxes,
  berthRenderRect,
  canonicalSAddress,
  defaultSignalDirection,
  SIGNAL_BERTH_SEARCH,
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
  /** 2026-09-27 (owner): make every berth `BERTH_TOOL_WIDTH` wide about its centre; a signal next
   * to a trimmed end moves in with it, keeping its gap to the box. */
  resizeBerths: boolean;
}

/** The berth width the tool resizes to. */
export const BERTH_TOOL_WIDTH = 40;

export const DEFAULT_SIGNAL_TOOL_OPTIONS: SignalToolOptions = {
  setNames: true,
  prefix: "",
  overwriteCustomNames: false,
  setDirections: true,
  overwriteCustomDirections: false,
  resizeBerths: true,
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
  /** Moving in (or out) with a resized berth's end. */
  position: SignalToolOutcome;
}

export interface SignalToolPlan {
  rows: SignalToolRow[];
  patches: Array<{ elementId: string; patch: Record<string, unknown> }>;
  /** Berths the tool resizes. */
  berthsResized: number;
  /** Routes whose ends the tool re-attaches to their signals. */
  routesRealigned: number;
  /** Routes whose ends are off their signals in a way the tool won't guess at — re-trace them. */
  routesNeedingRetrace: string[];
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
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  // Each berth's drawn box now, and how much each end moves in (negative: out) when resized.
  const berths = doc.elements.flatMap((e) =>
    e.type === "berth" ? [{ element: e, rect: berthRenderRect(e, byId) }] : [],
  );
  const trims = new Map<string, number>();
  if (options.resizeBerths) {
    for (const { element } of berths) {
      if (element.width !== BERTH_TOOL_WIDTH) {
        trims.set(element.id, (element.width - BERTH_TOOL_WIDTH) / 2);
      }
    }
  }
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

    let position: SignalToolOutcome = { status: "off" };
    if (options.resizeBerths) {
      const finalDirection = (patch.appliesTo as "right" | "left" | undefined) ?? element.appliesTo;
      const move = signalMoveWithBerth(element, finalDirection, berths, trims);
      if (move === 0) position = { status: "unchanged" };
      else {
        position = {
          status: "change",
          from: `x ${element.x}`,
          to: `x ${element.x + move} (${move < 0 ? "←" : "→"} ${Math.abs(move)})`,
        };
        patch.x = element.x + move;
      }
    }

    rows.push({
      elementId: element.id,
      current: element.label ?? null,
      name,
      direction,
      position,
    });
    if (Object.keys(patch).length > 0) patches.push({ elementId: element.id, patch });
  }

  for (const { element } of berths) {
    const trim = trims.get(element.id);
    if (trim === undefined) continue;
    patches.push({
      elementId: element.id,
      patch: { x: element.x + trim, width: BERTH_TOOL_WIDTH },
    });
  }

  // 2026-09-27 (owner): routes stay attached to their signals — both where this run moves a
  // signal and where an earlier move left a route end a short way off (routeEnds.ts).
  const finalX = new Map(
    patches.flatMap((p) => (typeof p.patch.x === "number" ? [[p.elementId, p.patch.x]] : [])),
  );
  const signalAt = (id: string) => {
    const signal = byId.get(id);
    if (!signal || signal.type !== "signal") return undefined;
    return { x: (finalX.get(id) as number | undefined) ?? signal.x, y: signal.y };
  };
  let routesRealigned = 0;
  const routesNeedingRetrace: string[] = [];
  for (const element of doc.elements) {
    if (element.type !== "route") continue;
    const check = checkRouteEnds(element, signalAt);
    if (check.status === "realign") {
      routesRealigned += 1;
      patches.push({ elementId: element.id, patch: { points: check.points } });
    } else if (check.status === "needs-retrace") {
      routesNeedingRetrace.push(element.label ?? element.id);
    }
  }

  return { rows, patches, berthsResized: trims.size, routesRealigned, routesNeedingRetrace };
}

/** How far a signal moves when the berth it stands next to is resized: it follows the berth end
 * it is next to (nearest box edge on its own track within 40), so its gap to the box is kept. A
 * signal to the right of a berth follows its right end, one to the left its left end — unless its
 * direction says it belongs to the other side. Inside a box, or exactly between two: no move. */
function signalMoveWithBerth(
  signal: SignalElement,
  direction: "right" | "left" | undefined,
  berths: ReadonlyArray<{
    element: { id: string };
    rect: { x: number; y: number; width: number; height: number };
  }>,
  trims: ReadonlyMap<string, number>,
): number {
  let after: { distance: number; id: string } | null = null; // berth on the signal's left
  let before: { distance: number; id: string } | null = null; // berth on the signal's right
  for (const { element, rect } of berths) {
    if (Math.abs(rect.y + rect.height / 2 - signal.y) > 4) continue;
    const right = rect.x + rect.width;
    if (signal.x > rect.x && signal.x < right) return 0;
    if (signal.x >= right && (!after || signal.x - right < after.distance)) {
      after = { distance: signal.x - right, id: element.id };
    }
    if (signal.x <= rect.x && (!before || rect.x - signal.x < before.distance)) {
      before = { distance: rect.x - signal.x, id: element.id };
    }
  }
  const a = after && after.distance <= SIGNAL_BERTH_SEARCH ? after : null;
  const b = before && before.distance <= SIGNAL_BERTH_SEARCH ? before : null;
  if (a && (!b || a.distance < b.distance) && direction !== "left") {
    return -(trims.get(a.id) ?? 0);
  }
  if (b && (!a || b.distance < a.distance) && direction !== "right") {
    return trims.get(b.id) ?? 0;
  }
  return 0;
}

/** Counts for the preview's summary line. */
export function summariseSignalTool(plan: SignalToolPlan): {
  signals: number;
  namesChanged: number;
  namesSkipped: number;
  directionsChanged: number;
  directionsSkipped: number;
  berthsResized: number;
  signalsMoved: number;
  routesRealigned: number;
} {
  const count = (pick: (row: SignalToolRow) => SignalToolOutcome, status: string) =>
    plan.rows.filter((row) => pick(row).status === status).length;
  return {
    signals: plan.rows.length,
    namesChanged: count((r) => r.name, "change"),
    namesSkipped: count((r) => r.name, "skipped"),
    directionsChanged: count((r) => r.direction, "change"),
    directionsSkipped: count((r) => r.direction, "skipped"),
    berthsResized: plan.berthsResized,
    signalsMoved: count((r) => r.position, "change"),
    routesRealigned: plan.routesRealigned,
  };
}
