import {
  computeBoundingBox,
  resolvePlacements,
  type MapDocument,
  type MapElement,
  type MapJoin,
  type ModuleIssue,
  type ModuleUse,
} from "@railway/map-schema";

/**
 * Milestone 85 (docs/adr/0019): editor-side helpers for modules — pure, so they are tested
 * without a canvas.
 */

/** The editor's view of one module an assembled map uses (`GET /api/v1/editor/modules`). */
export interface EditorModule {
  slug: string;
  name: string;
  draft: MapDocument | null;
  draftRevision: number | null;
  published: MapDocument | null;
  publishedVersion: number | null;
}

/** One module (or the assembled map's own elements) drawn dimmed behind what is being edited. */
export interface BackdropItem {
  key: string;
  title: string | null;
  elements: MapElement[];
  joins: MapJoin[];
  dx: number;
  dy: number;
  /** Free-placed modules can be dragged; attached ones go where their joins say. */
  draggable: boolean;
}

/** The default new join: vertical, 60 units, centred on the clicked point. */
export const DEFAULT_JOIN_LENGTH = 60;

export function nextJoinId(joins: MapJoin[]): string {
  const taken = new Set(joins.map((join) => join.id));
  let n = joins.length + 1;
  while (taken.has(`join-${n}`)) n += 1;
  return `join-${n}`;
}

export function nextJoinName(joins: MapJoin[]): string {
  const taken = new Set(joins.map((join) => join.name.toLowerCase()));
  let n = joins.length + 1;
  while (taken.has(`join ${n}`)) n += 1;
  return `Join ${n}`;
}

export function newJoinAt(point: { x: number; y: number }, joins: MapJoin[]): MapJoin {
  return {
    id: nextJoinId(joins),
    name: nextJoinName(joins),
    points: [
      { x: point.x, y: point.y - DEFAULT_JOIN_LENGTH / 2 },
      { x: point.x, y: point.y + DEFAULT_JOIN_LENGTH / 2 },
    ],
  };
}

/** Each module's document for previewing: its draft, or its published version if it has no
 * draft. */
export function previewDocs(modules: EditorModule[]): Map<string, MapDocument> {
  const docs = new Map<string, MapDocument>();
  for (const module of modules) {
    const doc = module.draft ?? module.published;
    if (doc) docs.set(module.slug, doc);
  }
  return docs;
}

export interface AssemblyView {
  items: BackdropItem[];
  issues: ModuleIssue[];
  /** Where each placed module ended up. */
  offsets: Map<string, { dx: number; dy: number }>;
}

/** The modules of the assembled map being edited, placed for the canvas. */
export function assemblyBackdrop(doc: MapDocument, modules: EditorModule[]): AssemblyView {
  const docs = previewDocs(modules);
  const { placements, issues } = resolvePlacements(doc, docs);
  const names = new Map(modules.map((module) => [module.slug, module.name]));
  const items: BackdropItem[] = [];
  for (const use of doc.modules ?? []) {
    const offset = placements.get(use.slug);
    const moduleDoc = docs.get(use.slug);
    if (!offset || !moduleDoc) continue;
    items.push({
      key: use.slug,
      title: names.get(use.slug) ?? use.slug,
      elements: moduleDoc.elements,
      joins: moduleDoc.joins ?? [],
      dx: offset.dx,
      dy: offset.dy,
      draggable: use.placement.kind === "at",
    });
  }
  return { items, issues, offsets: placements };
}

/**
 * The rest of an assembled map, drawn around a module being edited in place: every other module
 * and the assembled map's own elements, moved so the module being edited sits at its own
 * coordinates. `current` is the module's live document, so its joins (and so everything attached
 * beyond it) follow as it is edited. Null when the module isn't placed in that map.
 */
export function contextBackdrop(
  moduleSlug: string,
  current: MapDocument,
  assembled: MapDocument,
  modules: EditorModule[],
): AssemblyView | null {
  const docs = previewDocs(modules);
  docs.set(moduleSlug, current);
  const { placements, issues } = resolvePlacements(assembled, docs);
  const own = placements.get(moduleSlug);
  if (!own) return null;
  const names = new Map(modules.map((module) => [module.slug, module.name]));
  const items: BackdropItem[] = [
    {
      key: "__assembled",
      title: null,
      elements: assembled.elements,
      joins: [],
      dx: -own.dx,
      dy: -own.dy,
      draggable: false,
    },
  ];
  for (const use of assembled.modules ?? []) {
    if (use.slug === moduleSlug) continue;
    const offset = placements.get(use.slug);
    const doc = docs.get(use.slug);
    if (!offset || !doc) continue;
    items.push({
      key: use.slug,
      title: names.get(use.slug) ?? use.slug,
      elements: doc.elements,
      joins: doc.joins ?? [],
      dx: offset.dx - own.dx,
      dy: offset.dy - own.dy,
      draggable: false,
    });
  }
  return { items, issues, offsets: placements };
}

/** Where a newly added module goes: to the right of everything already on the canvas, so it
 * never lands on top of existing work. */
export function placementForNewModule(
  doc: MapDocument,
  backdrop: BackdropItem[],
  gridSize: number,
): ModuleUse["placement"] {
  const boxes = [
    { elements: doc.elements, dx: 0, dy: 0 },
    ...backdrop.map((item) => ({ elements: item.elements, dx: item.dx, dy: item.dy })),
  ]
    .filter((part) => part.elements.length > 0)
    .map((part) => {
      const box = computeBoundingBox(part.elements);
      return { maxX: box.maxX + part.dx, minY: box.minY + part.dy };
    })
    .filter((box) => Number.isFinite(box.maxX) && Number.isFinite(box.minY));
  if (boxes.length === 0) return { kind: "at", x: 0, y: 0 };
  const snap = (value: number) => Math.round(value / gridSize) * gridSize;
  return {
    kind: "at",
    x: snap(Math.max(...boxes.map((box) => box.maxX)) + 100),
    y: snap(Math.min(...boxes.map((box) => box.minY))),
  };
}

/** Plain words for how a module is placed. */
export function placementSummary(
  use: ModuleUse,
  joinName: (slug: string, joinId: string) => string | undefined,
  moduleName: (slug: string) => string,
): string {
  if (use.placement.kind === "at") return "Placed freely (drag it on the canvas)";
  const { join, to, toJoin } = use.placement;
  return `Its ${joinName(use.slug, join) ?? join} joins ${moduleName(to)}'s ${joinName(to, toJoin) ?? toJoin}`;
}
