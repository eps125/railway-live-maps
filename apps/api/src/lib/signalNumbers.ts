import type { CompiledMapBundle } from "@railway/map-schema";

/**
 * Milestone 99 (docs/adr/0022): a copy of a map bundle with every signal's number (`label`)
 * removed, for viewers without `map.signal_numbers` — so the numbers are never sent rather than
 * merely not drawn. The stored bundle (immutable, CLAUDE.md rule 11) is not touched.
 */
export function withoutSignalNumbers(bundle: CompiledMapBundle): CompiledMapBundle {
  if (!bundle.elementsById) return bundle;
  let changed = false;
  const elementsById: CompiledMapBundle["elementsById"] = {};
  for (const [id, element] of Object.entries(bundle.elementsById)) {
    if (element.type === "signal" && element.label !== undefined) {
      const { label: _label, labelOffset: _offset, labelSource: _source, ...rest } = element;
      elementsById[id] = rest;
      changed = true;
    } else {
      elementsById[id] = element;
    }
  }
  return changed ? { ...bundle, elementsById } : bundle;
}
