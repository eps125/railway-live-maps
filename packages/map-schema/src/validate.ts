import { MapDocumentSchema, type MapDocument, type TrackPathElement } from "./document.js";
import { routePointsOffTrack } from "./trackGraph.js";

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

  const berthElementIds = new Set(
    doc.elements.filter((element) => element.type === "berth").map((element) => element.id),
  );
  for (const element of doc.elements) {
    if (element.type !== "berth" || !element.inhibitedBy) continue;
    if (element.inhibitedBy === element.id) {
      errors.push({
        code: "inhibited_by_self_reference",
        message: `Berth element "${element.id}" cannot be inhibited by itself`,
        elementId: element.id,
      });
    } else if (!berthElementIds.has(element.inhibitedBy)) {
      errors.push({
        code: "inhibited_by_missing_element",
        message: `Berth element "${element.id}" is inhibited by missing berth element "${element.inhibitedBy}"`,
        elementId: element.id,
      });
    }
  }

  // Combined berths (owner request 2026-09-17): a berth element may have more than one tdBerth
  // binding sharing its elementId — up to 4, for a physical split-berth group displayed as one
  // box. That grouping must be explicit (every member carries a distinct combinedOrder), never
  // an accident of two unrelated bindings ending up on the same elementId.
  const tdBindingsByElementId = new Map<
    string,
    Array<{ id: string; combinedOrder: number | undefined }>
  >();
  for (const binding of doc.bindings) {
    if (binding.type !== "tdBerth") continue;
    const list = tdBindingsByElementId.get(binding.elementId) ?? [];
    list.push({ id: binding.id, combinedOrder: binding.combinedOrder });
    tdBindingsByElementId.set(binding.elementId, list);
  }
  for (const [elementId, group] of tdBindingsByElementId) {
    if (group.length <= 1) {
      if (group[0]?.combinedOrder !== undefined) {
        errors.push({
          code: "combined_order_without_group",
          message: `Berth element "${elementId}" sets combinedOrder but has no sibling binding to combine with`,
          elementId,
          bindingId: group[0].id,
        });
      }
      continue;
    }
    if (group.length > 4) {
      errors.push({
        code: "combined_berth_too_many_members",
        message: `Berth element "${elementId}" combines ${group.length} bindings; the maximum is 4`,
        elementId,
      });
    }
    const orders = group.map((b) => b.combinedOrder);
    if (orders.some((order) => order === undefined)) {
      errors.push({
        code: "combined_berth_missing_order",
        message: `Berth element "${elementId}" has ${group.length} bindings sharing it but not every one sets combinedOrder`,
        elementId,
      });
    } else if (new Set(orders).size !== orders.length) {
      errors.push({
        code: "combined_berth_duplicate_order",
        message: `Berth element "${elementId}"'s combined bindings must have distinct combinedOrder values`,
        elementId,
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

  // Milestone 36c: S-Class signal bindings. A signal shows exactly one bit (rule 9: on/off only),
  // so more than one binding on a signal would make its state ambiguous; and a tdSBit binding
  // only means something on a signal element.
  const elementsById = new Map(doc.elements.map((element) => [element.id, element]));
  const sBitCountByElement = new Map<string, number>();
  for (const binding of doc.bindings) {
    if (binding.type !== "tdSBit") continue;
    const element = elementsById.get(binding.elementId);
    if (element && element.type !== "signal") {
      errors.push({
        code: "invalid_signal_binding",
        message: `S-Class binding "${binding.id}" is on ${element.type} element "${element.id}" — only signals can have one`,
        elementId: element.id,
        bindingId: binding.id,
      });
    }
    sBitCountByElement.set(binding.elementId, (sBitCountByElement.get(binding.elementId) ?? 0) + 1);
  }
  for (const [elementId, count] of sBitCountByElement) {
    if (count > 1) {
      errors.push({
        code: "multiple_signal_bindings",
        message: `Signal "${elementId}" has ${count} S-Class bindings — a signal shows exactly one bit`,
        elementId,
      });
    }
  }

  // Milestone 55 / ADR 0014: the same two rules for a level crossing's barrier binding. A
  // crossing shows exactly one bit, and a barrier binding only means something on a crossing.
  const barrierCountByElement = new Map<string, number>();
  // Milestone 59 / ADR 0015: an inferred binding is a barrier source too, so it counts toward the
  // same one-per-crossing limit and the same levelCrossing-only rule as a direct LXC bit.
  for (const binding of doc.bindings) {
    if (binding.type !== "tdSBitBarrier" && binding.type !== "tdSBitBarrierInferred") continue;
    const element = elementsById.get(binding.elementId);
    if (element && element.type !== "levelCrossing") {
      errors.push({
        code: "invalid_barrier_binding",
        message: `Barrier binding "${binding.id}" is on ${element.type} element "${element.id}" — only level crossings can have one`,
        elementId: element.id,
        bindingId: binding.id,
      });
    }
    barrierCountByElement.set(
      binding.elementId,
      (barrierCountByElement.get(binding.elementId) ?? 0) + 1,
    );
  }
  for (const [elementId, count] of barrierCountByElement) {
    if (count > 1) {
      errors.push({
        code: "multiple_barrier_bindings",
        message: `Level crossing "${elementId}" has ${count} barrier sources — a crossing is driven by one S-Class bit, one inferred rule, or nothing`,
        elementId,
      });
    }
  }

  // Milestone 64 / ADR 0016: a route belongs to its entry signal, so that must be a real signal
  // (and so must the exit signal when one is given); a route binding only means something on a
  // route; and a route shows exactly one bit.
  for (const element of doc.elements) {
    if (element.type !== "route") continue;
    const ends: Array<["entry" | "exit", string | undefined]> = [
      ["entry", element.entrySignalId],
      ["exit", element.exitSignalId],
    ];
    for (const [end, signalId] of ends) {
      if (signalId === undefined) continue;
      if (elementsById.get(signalId)?.type !== "signal") {
        errors.push({
          code: `route_${end}_not_signal`,
          message: `Route "${element.id}" has ${end} signal "${signalId}", which is not a signal on this map`,
          elementId: element.id,
        });
      }
    }
  }
  const routeCountByElement = new Map<string, number>();
  for (const binding of doc.bindings) {
    if (binding.type !== "tdSBitRoute") continue;
    const element = elementsById.get(binding.elementId);
    if (element && element.type !== "route") {
      errors.push({
        code: "invalid_route_binding",
        message: `Route binding "${binding.id}" is on ${element.type} element "${element.id}" — only routes can have one`,
        elementId: element.id,
        bindingId: binding.id,
      });
    }
    routeCountByElement.set(
      binding.elementId,
      (routeCountByElement.get(binding.elementId) ?? 0) + 1,
    );
  }
  for (const [elementId, count] of routeCountByElement) {
    if (count > 1) {
      errors.push({
        code: "multiple_route_bindings",
        message: `Route "${elementId}" has ${count} S-Class bindings — a route is shown from exactly one bit`,
        elementId,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Milestone 64 / ADR 0016: non-blocking checks on routes, for the editor's warnings tier. A route
 * that has drifted off the track still renders exactly where it was traced, so this is a prompt to
 * re-trace it, not an error.
 */
export function routeWarnings(doc: MapDocument): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  const tracks = doc.elements.filter(
    (element): element is TrackPathElement => element.type === "trackPath",
  );
  const trackIds = new Set(tracks.map((track) => track.id));
  const boundRoutes = new Set(
    doc.bindings.filter((binding) => binding.type === "tdSBitRoute").map((b) => b.elementId),
  );
  for (const element of doc.elements) {
    if (element.type !== "route") continue;
    const name = element.label ? `Route "${element.label}"` : `Route "${element.id}"`;
    const missing = element.trackIds.filter((id) => !trackIds.has(id));
    if (missing.length > 0) {
      warnings.push({
        code: "route_track_missing",
        message: `${name} was traced along track that no longer exists (${missing.join(", ")}) — re-trace it`,
        elementId: element.id,
      });
    }
    if (routePointsOffTrack(element.points, tracks).length > 0) {
      warnings.push({
        code: "route_off_track",
        message: `${name} no longer lies on the track — re-trace it`,
        elementId: element.id,
      });
    }
    if (!boundRoutes.has(element.id)) {
      warnings.push({
        code: "route_unbound",
        message: `${name} has no route bit bound, so it will never be shown`,
        elementId: element.id,
      });
    }
  }
  return warnings;
}
