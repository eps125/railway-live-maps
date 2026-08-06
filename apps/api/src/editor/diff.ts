import type { MapDocument } from "@railway/map-schema";

export interface IdDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export interface DocumentDiff {
  elements: IdDiff;
  bindings: IdDiff;
  layers: IdDiff;
}

function diffById<T extends { id: string }>(fromList: T[], toList: T[]): IdDiff {
  const fromById = new Map(fromList.map((item) => [item.id, item]));
  const toById = new Map(toList.map((item) => [item.id, item]));
  const added: string[] = [];
  const modified: string[] = [];

  for (const [id, item] of toById) {
    const previous = fromById.get(id);
    if (!previous) {
      added.push(id);
    } else if (JSON.stringify(previous) !== JSON.stringify(item)) {
      modified.push(id);
    }
  }
  const removed = [...fromById.keys()].filter((id) => !toById.has(id));

  return { added, removed, modified };
}

/**
 * Structural diff between two canonical map documents, keyed by each entity's own stable
 * `id` — a hand-rolled comparison over the specific domain shapes (elements/bindings/layers),
 * not a generic JSON-diff library, matching this repo's existing "hand-roll over dependency"
 * style. Backs `GET /api/v1/editor/maps/{slug}/diff` (docs/API_CONTRACT.md §4) for the editor's
 * Review mode ("compare a draft with the currently published version",
 * docs/PROJECT_SPEC.md §5).
 */
export function diffMapDocuments(from: MapDocument, to: MapDocument): DocumentDiff {
  return {
    elements: diffById(from.elements, to.elements),
    bindings: diffById(from.bindings, to.bindings),
    layers: diffById(from.layers, to.layers),
  };
}
