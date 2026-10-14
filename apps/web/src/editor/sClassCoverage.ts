import type { MapBinding, MapDocument, MapElement } from "@railway/map-schema";

/**
 * Milestone 91 (owner request 2026-10-14): S-Class binding coverage. The owner had no way to see,
 * from inside the editor, whether every defined signal or route bit had been bound, or whether a
 * bit had been bound twice. Pure: the panel supplies the documents and the area definitions.
 *
 * Sources are the document being edited plus, when it sits in an assembled map, the other parts
 * of that map — so a bit bound in another module still counts, and a bit bound in two modules
 * shows up as a double use.
 */

export interface CoverageDefinition {
  address: string;
  bit: number;
  kind: string;
  label: string | null;
  destination: string | null;
}

export interface CoverageSource {
  /** null = the document being edited (its elements can be selected and changed). */
  moduleSlug: string | null;
  /** How the source is named in the panel, e.g. "This module" or "winford-south". */
  name: string;
  doc: MapDocument;
}

export type UseKind = "signal" | "route" | "crossing" | "trts";

export interface BitUse {
  kind: UseKind;
  moduleSlug: string | null;
  sourceName: string;
  elementId: string;
  elementLabel: string | null;
  bindingId: string;
  allowDuplicate: boolean;
}

export interface DoubleUse {
  key: string;
  address: string;
  bit: number;
  kind: UseKind;
  definition: CoverageDefinition | null;
  uses: BitUse[];
  /** Every binding involved is marked as intended. */
  intended: boolean;
}

export interface BindingProblem {
  code: "undefined_bit" | "kind_mismatch" | "label_mismatch";
  use: BitUse;
  address: string;
  bit: number;
  definition: CoverageDefinition | null;
  message: string;
}

export interface AreaCoverage {
  tdArea: string;
  signals: { defined: number; bound: number };
  routes: { defined: number; bound: number };
  crossings: { defined: number; bound: number };
  /** Milestone 92: TRTS bits, bound on their starting signals. */
  trts: { defined: number; bound: number };
  /** Defined signal, route, crossing and TRTS bits nobody has bound. */
  unbound: CoverageDefinition[];
  doubleUses: DoubleUse[];
  problems: BindingProblem[];
  /** Signal bits used only as a crossing's inferred input (fine; shown for information). */
  crossingInputsOnly: CoverageDefinition[];
}

const KIND_FOR_BINDING: Record<string, UseKind> = {
  tdSBit: "signal",
  tdSBitRoute: "route",
  tdSBitBarrier: "crossing",
  tdSBitTrts: "trts",
};
const DEFINITION_KIND: Record<UseKind, string> = {
  signal: "signal",
  route: "route",
  crossing: "level_crossing",
  trts: "trts",
};

/** `"a"`/`"0a"` → `"0A"`. */
export function canonicalAddress(address: string): string {
  return address.toUpperCase().padStart(2, "0");
}

const bitKey = (address: string, bit: number) => `${canonicalAddress(address)}.${bit}`;

function elementLabel(element: MapElement | undefined): string | null {
  if (!element) return null;
  if ("label" in element && typeof element.label === "string" && element.label)
    return element.label;
  return null;
}

/** The signal number in a label: "CE135", "S0135" and "135" all give 135. */
function signalNumber(label: string | null): number | null {
  const match = label ? /(\d+)\D*$/.exec(label) : null;
  return match ? Number(match[1]) : null;
}

function labelsDisagree(kind: UseKind, element: string | null, definition: string | null): boolean {
  if (!element || !definition) return false;
  // A TRTS sits on its signal, so it is checked against that signal's number like a signal is.
  if (kind === "signal" || kind === "trts") {
    const a = signalNumber(element);
    const b = signalNumber(definition);
    return a !== null && b !== null && a !== b;
  }
  if (kind === "route") {
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return norm(element) !== norm(definition);
  }
  return false;
}

export function sClassCoverage(
  sources: CoverageSource[],
  definitionsByArea: Record<string, CoverageDefinition[]>,
): AreaCoverage[] {
  // Every S-Class use, per area and bit.
  const uses = new Map<string, Map<string, BitUse[]>>();
  const crossingInputs = new Map<string, Set<string>>();
  const areas = new Set<string>(Object.keys(definitionsByArea));
  const add = (area: string, key: string, use: BitUse) => {
    areas.add(area);
    const byBit = uses.get(area) ?? new Map<string, BitUse[]>();
    uses.set(area, byBit);
    byBit.set(key, [...(byBit.get(key) ?? []), use]);
  };

  for (const source of sources) {
    const byId = new Map(source.doc.elements.map((element) => [element.id, element]));
    for (const binding of source.doc.bindings as MapBinding[]) {
      if (binding.type === "tdSBitBarrierInferred") {
        for (const input of binding.inputs) {
          areas.add(input.tdArea);
          const set = crossingInputs.get(input.tdArea) ?? new Set<string>();
          set.add(bitKey(input.address, input.bit));
          crossingInputs.set(input.tdArea, set);
        }
        continue;
      }
      const kind = KIND_FOR_BINDING[binding.type];
      if (!kind || !("address" in binding)) continue;
      add(binding.tdArea, bitKey(binding.address, binding.bit), {
        kind,
        moduleSlug: source.moduleSlug,
        sourceName: source.name,
        elementId: binding.elementId,
        elementLabel: elementLabel(byId.get(binding.elementId)),
        bindingId: binding.id,
        allowDuplicate: "allowDuplicate" in binding && binding.allowDuplicate === true,
      });
    }
  }

  const result: AreaCoverage[] = [];
  for (const area of [...areas].sort()) {
    const definitions = definitionsByArea[area] ?? [];
    const defByKey = new Map(definitions.map((d) => [bitKey(d.address, d.bit), d]));
    const byBit = uses.get(area) ?? new Map<string, BitUse[]>();
    const inputs = crossingInputs.get(area) ?? new Set<string>();

    const count = (kind: UseKind) => {
      const defined = definitions.filter((d) => d.kind === DEFINITION_KIND[kind]);
      const bound = defined.filter((d) =>
        (byBit.get(bitKey(d.address, d.bit)) ?? []).some((u) => u.kind === kind),
      );
      return { defined: defined.length, bound: bound.length };
    };

    const unbound = definitions.filter((d) => {
      const kind = (Object.keys(DEFINITION_KIND) as UseKind[]).find(
        (k) => DEFINITION_KIND[k] === d.kind,
      );
      if (!kind) return false;
      // A signal bit already feeding a crossing is listed separately, not as missing.
      if (kind === "signal" && inputs.has(bitKey(d.address, d.bit))) return false;
      return !(byBit.get(bitKey(d.address, d.bit)) ?? []).some((u) => u.kind === kind);
    });

    const doubleUses: DoubleUse[] = [];
    const problems: BindingProblem[] = [];
    for (const [key, list] of byBit) {
      const [address, bitText] = key.split(".");
      const bit = Number(bitText);
      const definition = defByKey.get(key) ?? null;
      for (const kind of ["signal", "route", "crossing", "trts"] as UseKind[]) {
        const same = list.filter((u) => u.kind === kind);
        if (same.length > 1) {
          doubleUses.push({
            key,
            address: address!,
            bit,
            kind,
            definition,
            uses: same,
            intended: same.every((u) => u.allowDuplicate),
          });
        }
      }
      for (const use of list) {
        if (!definition) {
          problems.push({
            code: "undefined_bit",
            use,
            address: address!,
            bit,
            definition,
            message: `${area} ${key} has no definition`,
          });
          continue;
        }
        if (definition.kind !== "unknown" && definition.kind !== DEFINITION_KIND[use.kind]) {
          problems.push({
            code: "kind_mismatch",
            use,
            address: address!,
            bit,
            definition,
            message: `${area} ${key} is defined as a ${definition.kind.replace("_", " ")}, but a ${use.kind} is bound to it`,
          });
        } else if (labelsDisagree(use.kind, use.elementLabel, definition.label)) {
          problems.push({
            code: "label_mismatch",
            use,
            address: address!,
            bit,
            definition,
            message: `${use.elementLabel} is bound to ${area} ${key}, which is defined as ${definition.label}`,
          });
        }
      }
    }
    doubleUses.sort((a, b) => a.key.localeCompare(b.key));
    problems.sort((a, b) => `${a.address}.${a.bit}`.localeCompare(`${b.address}.${b.bit}`));

    const crossingInputsOnly = definitions.filter(
      (d) =>
        d.kind === "signal" &&
        inputs.has(bitKey(d.address, d.bit)) &&
        !(byBit.get(bitKey(d.address, d.bit)) ?? []).some((u) => u.kind === "signal"),
    );

    result.push({
      tdArea: area,
      signals: count("signal"),
      routes: count("route"),
      crossings: count("crossing"),
      trts: count("trts"),
      unbound,
      doubleUses,
      problems,
      crossingInputsOnly,
    });
  }
  return result;
}
