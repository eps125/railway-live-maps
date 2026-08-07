import { MapDocumentSchema } from "./document.js";

export interface ValidationIssue {
  code: string;
  message: string;
  elementId?: string;
  bindingId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

/**
 * Schema + structural validation for the publication-blocking errors in
 * docs/MAP_EDITOR_SPEC.md §9 that are checkable without external data: duplicate element IDs,
 * missing referenced layer/node, invalid/empty required berth binding, duplicate berth binding,
 * topology edge with a missing node, unsupported binding type (rejected by the schema parse
 * itself). Cross-map adjacent-boundary existence and "ever observed in nationwide data" warnings
 * need a DB lookup and are intentionally out of scope for this pure package — left for the
 * publish/editor API layer once that context exists (Milestone 11/12).
 */
export function validateMapDocument(json: unknown): ValidationResult {
  const parsed = MapDocumentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "invalid_schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    };
  }

  const doc = parsed.data;
  const errors: ValidationIssue[] = [];

  const layerIds = new Set(doc.layers.map((layer) => layer.id));
  const seenElementIds = new Set<string>();
  for (const element of doc.elements) {
    if (seenElementIds.has(element.id)) {
      errors.push({
        code: "duplicate_element_id",
        message: `Duplicate element id "${element.id}"`,
        elementId: element.id,
      });
    }
    seenElementIds.add(element.id);

    if (!layerIds.has(element.layerId)) {
      errors.push({
        code: "missing_layer",
        message: `Element "${element.id}" references missing layer "${element.layerId}"`,
        elementId: element.id,
      });
    }
  }

  const nodeIds = new Set(doc.topology.nodes.map((node) => node.id));
  for (const edge of doc.topology.edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      errors.push({
        code: "topology_edge_missing_node",
        message: `Topology edge "${edge.id}" references a missing node`,
      });
    }
  }

  const bindingsById = new Map(doc.bindings.map((binding) => [binding.id, binding]));
  // `doc.bindings` (matched by `binding.elementId`) is what the compiler actually reads to
  // build the published berthBindingIndex (see compiler.ts) — it never looks at
  // `element.bindingId`. That field is a redundant back-reference kept in sync by the editor's
  // setBinding command, but nothing prevents it drifting stale (a past editor bug did exactly
  // this), so it must not be treated as authoritative here — doing so previously let a berth
  // with a real, working binding still get flagged as unbound.
  const bindingsByElementId = new Map(doc.bindings.map((binding) => [binding.elementId, binding]));
  for (const element of doc.elements) {
    if (element.type !== "berth") continue;
    const binding = bindingsByElementId.get(element.id);
    if (!binding) {
      errors.push({
        code: "missing_berth_binding",
        message: `Berth element "${element.id}" has no binding`,
        elementId: element.id,
      });
      continue;
    }
    if (binding.type !== "tdBerth") {
      errors.push({
        code: "invalid_berth_binding",
        message: `Berth element "${element.id}" references a non-tdBerth binding`,
        elementId: element.id,
        bindingId: binding.id,
      });
    }
  }

  const tdBerthBindingIdsByKey = new Map<string, string[]>();
  for (const binding of doc.bindings) {
    if (binding.type !== "tdBerth") continue;
    const key = `${binding.tdArea}|${binding.berth}`;
    const ids = tdBerthBindingIdsByKey.get(key) ?? [];
    ids.push(binding.id);
    tdBerthBindingIdsByKey.set(key, ids);
  }
  for (const [key, ids] of tdBerthBindingIdsByKey) {
    if (ids.length <= 1) continue;
    const anyAllowsDuplicate = ids.some((id) => {
      const binding = bindingsById.get(id);
      return binding?.type === "tdBerth" && binding.allowDuplicate;
    });
    if (!anyAllowsDuplicate) {
      errors.push({
        code: "duplicate_berth_binding",
        message: `Berth binding ${key} is used ${ids.length} times without allowDuplicate`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
