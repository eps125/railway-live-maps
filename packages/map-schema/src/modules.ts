import type {
  MapDocument,
  MapElement,
  MapBinding,
  TopologyNode,
  TopologyEdge,
} from "./document.js";
import type { ModuleUse, MapJoin } from "./document.js";

/**
 * Milestone 85 (docs/adr/0019): map modules. A module is an ordinary map document, drawn once,
 * with named **joins** — short lines drawn across the track ends at its edge. An assembled map's
 * document lists the modules it uses (`modules`) and its own local elements. Each module is either
 * placed at a point, or **attached**: one of its joins laid onto a join of a module already placed.
 * Attached positions are calculated from the joins, never typed in, so a module that grows pushes
 * everything attached beyond it along.
 *
 * `flattenAssembledMap` turns the assembled document plus its modules into one ordinary map
 * document — what is published, compiled and rendered exactly like a hand-drawn map. A module's
 * ids are qualified as `<module slug>/<id>` so modules can never collide; a reference that already
 * contains `/` is a deliberate reference into another module and is left alone.
 */

type Point = { x: number; y: number };

/** How far a track end may be from a join's line and still belong to it. */
export const JOIN_TRACK_END_TOLERANCE = 3;
/** How far two track ends may be apart once a module is attached and still count as meeting. */
export const JOIN_MATCH_TOLERANCE = 1;

export interface ModuleIssue {
  code:
    | "module_missing"
    | "module_nested"
    | "module_duplicate"
    | "join_missing"
    | "join_not_parallel"
    | "join_track_count_mismatch"
    | "join_tracks_misaligned"
    | "attach_unresolved"
    | "local_id_reserved";
  message: string;
  moduleSlug?: string;
}

export interface ResolvedPlacement {
  slug: string;
  dx: number;
  dy: number;
}

export interface FlattenResult {
  doc: MapDocument;
  placements: ResolvedPlacement[];
  issues: ModuleIssue[];
}

export function qualifyId(moduleSlug: string, id: string): string {
  return id.includes("/") ? id : `${moduleSlug}/${id}`;
}

function distanceToSegment(p: Point, a: Point, b: Point): { distance: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return { distance: Math.hypot(p.x - cx, p.y - cy), t };
}

/** The ends of `trackPath`s lying on a join's line, in order from its first point to its second. */
export function joinTrackEnds(elements: MapElement[], join: MapJoin): Point[] {
  const [a, b] = join.points;
  const found: Array<{ point: Point; t: number }> = [];
  for (const element of elements) {
    if (element.type !== "trackPath") continue;
    const ends = [element.points[0]!, element.points[element.points.length - 1]!];
    for (const end of ends) {
      const { distance, t } = distanceToSegment(end, a, b);
      if (distance <= JOIN_TRACK_END_TOLERANCE) found.push({ point: end, t });
    }
  }
  found.sort((p, q) => p.t - q.t);
  // Two tracks ending at the same point on the join are one track end.
  const unique: Point[] = [];
  for (const { point } of found) {
    const last = unique[unique.length - 1];
    if (!last || Math.hypot(last.x - point.x, last.y - point.y) > JOIN_MATCH_TOLERANCE) {
      unique.push(point);
    }
  }
  return unique;
}

function unit(a: Point, b: Point): Point {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return length === 0 ? { x: 0, y: 0 } : { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

export interface JoinFit {
  dx: number;
  dy: number;
  issues: ModuleIssue[];
}

/**
 * Where module `moving` must be so its join `movingJoin` lies on `fixedJoin` (already in place,
 * given in final coordinates). The joins must be parallel (either way round). Their track ends are
 * lined up first-to-first (last-to-first when drawn the other way round), so two hand-drawn joins
 * of different lengths still meet exactly at the track; with no track ends, the joins' midpoints
 * are lined up. Every track end must then meet one on the other side.
 */
export function fitJoin(
  movingElements: MapElement[],
  movingJoin: MapJoin,
  fixedElements: MapElement[],
  fixedJoin: MapJoin,
  movingSlug: string,
): JoinFit {
  const issues: ModuleIssue[] = [];
  const u = unit(movingJoin.points[0], movingJoin.points[1]);
  const v = unit(fixedJoin.points[0], fixedJoin.points[1]);
  const dot = u.x * v.x + u.y * v.y;
  if (Math.abs(Math.abs(dot) - 1) > 0.01) {
    issues.push({
      code: "join_not_parallel",
      message: `Join "${movingJoin.name}" of ${movingSlug} does not run the same way as "${fixedJoin.name}"`,
      moduleSlug: movingSlug,
    });
  }
  const reversed = dot < 0;
  const movingEnds = joinTrackEnds(movingElements, movingJoin);
  const fixedEnds = joinTrackEnds(fixedElements, fixedJoin);
  if (reversed) movingEnds.reverse();

  let dx: number;
  let dy: number;
  if (movingEnds.length > 0 && fixedEnds.length > 0) {
    dx = fixedEnds[0]!.x - movingEnds[0]!.x;
    dy = fixedEnds[0]!.y - movingEnds[0]!.y;
  } else {
    const mid = (j: MapJoin): Point => ({
      x: (j.points[0].x + j.points[1].x) / 2,
      y: (j.points[0].y + j.points[1].y) / 2,
    });
    dx = mid(fixedJoin).x - mid(movingJoin).x;
    dy = mid(fixedJoin).y - mid(movingJoin).y;
  }

  if (movingEnds.length !== fixedEnds.length) {
    issues.push({
      code: "join_track_count_mismatch",
      message: `Join "${movingJoin.name}" of ${movingSlug} has ${movingEnds.length} track end(s) but "${fixedJoin.name}" has ${fixedEnds.length}`,
      moduleSlug: movingSlug,
    });
  } else {
    const misaligned = movingEnds.some((end, i) => {
      const other = fixedEnds[i]!;
      return Math.hypot(end.x + dx - other.x, end.y + dy - other.y) > JOIN_MATCH_TOLERANCE;
    });
    if (misaligned) {
      issues.push({
        code: "join_tracks_misaligned",
        message: `The tracks at join "${movingJoin.name}" of ${movingSlug} don't line up with those at "${fixedJoin.name}" — the spacing differs`,
        moduleSlug: movingSlug,
      });
    }
  }
  return { dx, dy, issues };
}

function translateElements(elements: MapElement[], dx: number, dy: number): MapElement[] {
  if (dx === 0 && dy === 0) return elements;
  return elements.map((element) => {
    const moved: Record<string, unknown> = { ...element };
    // Structural, not per type: every absolute position in an element is `x`/`y` or `points`
    // (offsets such as `labelOffset` are relative and stay as they are).
    if (typeof moved.x === "number" && typeof moved.y === "number") {
      moved.x = (moved.x as number) + dx;
      moved.y = (moved.y as number) + dy;
    }
    if (Array.isArray(moved.points)) {
      moved.points = (moved.points as Point[]).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    return moved as MapElement;
  });
}

function translateJoin(join: MapJoin, dx: number, dy: number): MapJoin {
  return {
    ...join,
    points: [
      { x: join.points[0].x + dx, y: join.points[0].y + dy },
      { x: join.points[1].x + dx, y: join.points[1].y + dy },
    ],
  };
}

/** Every element field that holds another element's (or binding's, or topology edge's) id. */
const SINGLE_REFERENCE_FIELDS = [
  "trackElementId",
  "bindingId",
  "stationId",
  "inhibitedBy",
  "platformId",
  "entrySignalId",
  "exitSignalId",
  "topologyEdgeId",
] as const;

function qualifyElement(element: MapElement, slug: string): MapElement {
  const out: Record<string, unknown> = { ...element, id: qualifyId(slug, element.id) };
  for (const field of SINGLE_REFERENCE_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = qualifyId(slug, value);
  }
  if (Array.isArray(out.trackIds)) {
    out.trackIds = (out.trackIds as string[]).map((id) => qualifyId(slug, id));
  }
  return out as MapElement;
}

function qualifyBinding(binding: MapBinding, slug: string): MapBinding {
  return {
    ...binding,
    id: qualifyId(slug, binding.id),
    elementId: qualifyId(slug, binding.elementId),
  };
}

/** Resolves where every module goes: placed ones first, then attachments in dependency order. */
export function resolvePlacements(
  source: MapDocument,
  modules: ReadonlyMap<string, MapDocument>,
): { placements: Map<string, { dx: number; dy: number }>; issues: ModuleIssue[] } {
  const issues: ModuleIssue[] = [];
  const placements = new Map<string, { dx: number; dy: number }>();
  const uses: ModuleUse[] = [];
  const seen = new Set<string>();
  for (const use of source.modules ?? []) {
    if (seen.has(use.slug)) {
      issues.push({
        code: "module_duplicate",
        message: `Module ${use.slug} is used more than once`,
        moduleSlug: use.slug,
      });
      continue;
    }
    seen.add(use.slug);
    const doc = modules.get(use.slug);
    if (!doc) {
      issues.push({
        code: "module_missing",
        message: `Module ${use.slug} has not been published (or no longer exists)`,
        moduleSlug: use.slug,
      });
      continue;
    }
    if ((doc.modules ?? []).length > 0) {
      issues.push({
        code: "module_nested",
        message: `Module ${use.slug} itself uses modules — modules can't be nested`,
        moduleSlug: use.slug,
      });
      continue;
    }
    uses.push(use);
  }

  for (const use of uses) {
    if (use.placement.kind === "at") {
      placements.set(use.slug, { dx: use.placement.x, dy: use.placement.y });
    }
  }

  let pending = uses.filter((use) => use.placement.kind === "attached");
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const still: ModuleUse[] = [];
    for (const use of pending) {
      if (use.placement.kind !== "attached") continue;
      const { join: joinId, to, toJoin: toJoinId } = use.placement;
      const target = placements.get(to);
      if (!target) {
        still.push(use);
        continue;
      }
      const movingDoc = modules.get(use.slug)!;
      const fixedDoc = modules.get(to)!;
      const movingJoin = (movingDoc.joins ?? []).find((j) => j.id === joinId);
      const fixedJoin = (fixedDoc.joins ?? []).find((j) => j.id === toJoinId);
      if (!movingJoin || !fixedJoin) {
        issues.push({
          code: "join_missing",
          message: !movingJoin
            ? `Module ${use.slug} has no join "${joinId}" any more`
            : `Module ${to} has no join "${toJoinId}" any more`,
          moduleSlug: use.slug,
        });
        progressed = true;
        continue;
      }
      const fit = fitJoin(
        movingDoc.elements,
        movingJoin,
        translateElements(fixedDoc.elements, target.dx, target.dy),
        translateJoin(fixedJoin, target.dx, target.dy),
        use.slug,
      );
      issues.push(...fit.issues);
      placements.set(use.slug, { dx: fit.dx, dy: fit.dy });
      progressed = true;
    }
    pending = still;
  }
  for (const use of pending) {
    issues.push({
      code: "attach_unresolved",
      message:
        use.placement.kind === "attached"
          ? `Module ${use.slug} is attached to ${use.placement.to}, which isn't placed (missing, or attached in a loop)`
          : `Module ${use.slug} can't be placed`,
      moduleSlug: use.slug,
    });
  }
  return { placements, issues };
}

function mergeTopology(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
  sourceOfNode: Map<string, string>,
): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  // Nodes from different modules at the same point are one node: that is where two modules join.
  const byPoint = new Map<string, TopologyNode>();
  const remap = new Map<string, string>();
  const kept: TopologyNode[] = [];
  for (const node of nodes) {
    const key = `${Math.round(node.x)}|${Math.round(node.y)}`;
    const existing = byPoint.get(key);
    if (existing && sourceOfNode.get(existing.id) !== sourceOfNode.get(node.id)) {
      remap.set(node.id, existing.id);
      continue;
    }
    if (!existing) byPoint.set(key, node);
    kept.push(node);
  }
  return {
    nodes: kept,
    edges: edges.map((edge) => ({
      ...edge,
      fromNodeId: remap.get(edge.fromNodeId) ?? edge.fromNodeId,
      toNodeId: remap.get(edge.toNodeId) ?? edge.toNodeId,
    })),
  };
}

/**
 * One ordinary map document from an assembled map and its modules (by slug). The assembled map's
 * own map settings, layers and local elements come first; each module's elements, bindings and
 * topology follow, moved into place and with their ids qualified. Joins are authoring aids and are
 * not part of the result. Issues are publication-blocking; the document is still returned (with
 * whatever could be placed) so the editor can show it.
 */
export function flattenAssembledMap(
  source: MapDocument,
  modules: ReadonlyMap<string, MapDocument>,
): FlattenResult {
  const { placements, issues } = resolvePlacements(source, modules);

  for (const element of source.elements) {
    if (element.id.includes("/")) {
      issues.push({
        code: "local_id_reserved",
        message: `Element id "${element.id}" contains "/", which is reserved for module elements`,
      });
    }
  }

  const layers = [...source.layers];
  const layerIds = new Set(layers.map((layer) => layer.id));
  const elements: MapElement[] = [...source.elements];
  const bindings: MapBinding[] = [...source.bindings];
  const nodes: TopologyNode[] = [...source.topology.nodes];
  const edges: TopologyEdge[] = [...source.topology.edges];
  const sourceOfNode = new Map<string, string>(nodes.map((node) => [node.id, ""]));
  const resolved: ResolvedPlacement[] = [];

  for (const use of source.modules ?? []) {
    const offset = placements.get(use.slug);
    const doc = modules.get(use.slug);
    if (!offset || !doc || resolved.some((p) => p.slug === use.slug)) continue;
    resolved.push({ slug: use.slug, dx: offset.dx, dy: offset.dy });
    for (const layer of doc.layers) {
      if (!layerIds.has(layer.id)) {
        layers.push(layer);
        layerIds.add(layer.id);
      }
    }
    for (const element of translateElements(doc.elements, offset.dx, offset.dy)) {
      elements.push(qualifyElement(element, use.slug));
    }
    for (const binding of doc.bindings) bindings.push(qualifyBinding(binding, use.slug));
    for (const node of doc.topology.nodes) {
      const id = qualifyId(use.slug, node.id);
      nodes.push({ id, x: node.x + offset.dx, y: node.y + offset.dy });
      sourceOfNode.set(id, use.slug);
    }
    for (const edge of doc.topology.edges) {
      edges.push({
        ...edge,
        id: qualifyId(use.slug, edge.id),
        fromNodeId: qualifyId(use.slug, edge.fromNodeId),
        toNodeId: qualifyId(use.slug, edge.toNodeId),
        ...(edge.trackElementId
          ? { trackElementId: qualifyId(use.slug, edge.trackElementId) }
          : {}),
      });
    }
  }

  const topology = mergeTopology(nodes, edges, sourceOfNode);
  const doc: MapDocument = {
    schemaVersion: source.schemaVersion,
    map: source.map,
    layers,
    elements,
    topology,
    bindings,
    editorMetadata: source.editorMetadata,
  };
  return { doc, placements: resolved, issues };
}

/** The slugs of the modules an assembled map uses. */
export function moduleSlugs(doc: MapDocument): string[] {
  return (doc.modules ?? []).map((use) => use.slug);
}

/** True for a document that is assembled from modules. */
export function isAssembledMap(doc: MapDocument): boolean {
  return (doc.modules ?? []).length > 0;
}

/** Element fields that point at another *element* (as opposed to a binding or topology edge). */
const ELEMENT_REFERENCE_FIELDS = [
  "trackElementId",
  "stationId",
  "inhibitedBy",
  "platformId",
  "entrySignalId",
  "exitSignalId",
] as const;

function elementReferences(element: MapElement): string[] {
  const record = element as unknown as Record<string, unknown>;
  const refs: string[] = [];
  for (const field of ELEMENT_REFERENCE_FIELDS) {
    const value = record[field];
    if (typeof value === "string") refs.push(value);
  }
  if (Array.isArray(record.trackIds)) refs.push(...(record.trackIds as string[]));
  return refs;
}

function rewriteElementReferences(
  element: MapElement,
  rewrite: (id: string) => string,
): MapElement {
  const out: Record<string, unknown> = { ...element };
  for (const field of ELEMENT_REFERENCE_FIELDS) {
    if (typeof out[field] === "string") out[field] = rewrite(out[field] as string);
  }
  if (Array.isArray(out.trackIds)) out.trackIds = (out.trackIds as string[]).map(rewrite);
  return out as MapElement;
}

export interface ExtractResult {
  /** The new module's document (same coordinates as in the map, so it is placed at 0,0). */
  moduleDoc: MapDocument;
  /** The map with the module's elements removed and the module added to its `modules`. */
  remainingDoc: MapDocument;
  /** Selected elements kept in the map because they refer to something outside the selection —
   * they reach into the module instead (e.g. a route whose exit signal stayed behind). */
  keptInMap: string[];
}

/**
 * Milestone 85: "make a module from the selection". The selected elements, their bindings and
 * their topology move into a new module placed at 0,0, so nothing moves on screen. A selected
 * element that refers to an element outside the selection stays in the map (a module can't refer
 * outwards); anything left in the map that referred to a moved element now refers to it by its
 * module-qualified id, so elements spanning modules keep working.
 */
export function extractModule(
  doc: MapDocument,
  elementIds: string[],
  module: { slug: string; name: string },
): ExtractResult {
  const allIds = new Set(doc.elements.map((element) => element.id));
  const selected = new Set(elementIds.filter((id) => allIds.has(id)));
  const keptInMap: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of doc.elements) {
      if (!selected.has(element.id)) continue;
      const outward = elementReferences(element).some(
        (ref) => allIds.has(ref) && !selected.has(ref),
      );
      if (outward) {
        selected.delete(element.id);
        keptInMap.push(element.id);
        changed = true;
      }
    }
  }

  const moved = doc.elements.filter((element) => selected.has(element.id));
  const movedBindings = doc.bindings.filter((binding) => selected.has(binding.elementId));
  const movedEdges = doc.topology.edges.filter(
    (edge) => edge.trackElementId !== undefined && selected.has(edge.trackElementId),
  );
  const movedEdgeIds = new Set(movedEdges.map((edge) => edge.id));
  const keptEdges = doc.topology.edges.filter((edge) => !movedEdgeIds.has(edge.id));
  const nodesUsedBy = (edges: TopologyEdge[]): Set<string> =>
    new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const movedNodeIds = nodesUsedBy(movedEdges);
  const keptNodeIds = nodesUsedBy(keptEdges);

  const qualify = (id: string): string => (selected.has(id) ? `${module.slug}/${id}` : id);
  const moduleDoc: MapDocument = {
    schemaVersion: doc.schemaVersion,
    map: { ...doc.map, id: module.slug, name: module.name, homePoint: undefined },
    layers: doc.layers,
    elements: moved,
    topology: {
      nodes: doc.topology.nodes.filter((node) => movedNodeIds.has(node.id)),
      edges: movedEdges,
    },
    bindings: movedBindings,
    editorMetadata: {},
    joins: [],
  };
  const remainingDoc: MapDocument = {
    ...doc,
    elements: doc.elements
      .filter((element) => !selected.has(element.id))
      .map((element) => rewriteElementReferences(element, qualify)),
    bindings: doc.bindings.filter((binding) => !selected.has(binding.elementId)),
    topology: {
      nodes: doc.topology.nodes.filter(
        (node) => keptNodeIds.has(node.id) || !movedNodeIds.has(node.id),
      ),
      edges: keptEdges,
    },
    modules: [...(doc.modules ?? []), { slug: module.slug, placement: { kind: "at", x: 0, y: 0 } }],
  };
  return { moduleDoc, remainingDoc, keptInMap };
}
