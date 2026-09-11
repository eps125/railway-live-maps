import { z } from "zod";

/** Canonical map JSON format (docs/MAP_EDITOR_SPEC.md §2-5). This is the versioned,
 * renderer-independent document — React/SVG/Konva are runtime representations only. */
export const MAP_SCHEMA_VERSION = 1;

const PointSchema = z.object({ x: z.number(), y: z.number() });

const CanvasSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  gridSize: z.number().positive(),
});

const MapMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canvas: CanvasSchema,
  timezone: z.string().min(1),
});

const LayerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  order: z.number().int(),
});

const BaseElementSchema = z.object({
  id: z.string().min(1),
  layerId: z.string().min(1),
  /** Paint order override. Defaults to 0, which means "use this element's layer's default
   * position" — with every element left at 0, the default stacking is exactly layer order
   * (tracks < berths < signals < everything else, per each layer's `order`). A small nudge (the
   * editor's +/- buttons move this by 1) reorders an element relative to others on the *same*
   * layer without escaping it. A large enough value is a deliberate full override that can cross
   * layer boundaries entirely (e.g. sinking a specific signal below a specific berth) — see
   * `sortElementsForPaint` in compiler.ts for the layer-order/zIndex combination this drives. */
  zIndex: z.number().int().default(0),
});

/** A schematic polyline. Visual line crossings do not imply connected track — logical
 * connectivity lives in `topology`, not here (docs/MAP_EDITOR_SPEC.md §4). */
const TrackPathElementSchema = BaseElementSchema.extend({
  type: z.literal("trackPath"),
  points: z.array(PointSchema).min(2),
  line: z.string().optional(),
  direction: z.enum(["up", "down", "bidirectional"]).optional(),
  topologyEdgeId: z.string().optional(),
});

/** 3-letter CRS station code (e.g. `LAN`). Uppercase only; the editor uppercases on commit. */
const CrsSchema = z.string().regex(/^[A-Z]{3}$/, "CRS must be 3 uppercase letters");

const BerthElementSchema = BaseElementSchema.extend({
  type: z.literal("berth"),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  textAlign: z.enum(["left", "center", "right"]).default("center"),
  fontSize: z.number().positive().default(12),
  displayName: z.string().min(1),
  bindingId: z.string().optional(),
  trackElementId: z.string().optional(),
  tooltip: z.string().optional(),
  /** ADR 0004 D6/D7: optional link to a `station` element and/or a bare CRS. Map-authoring
   * metadata only — it does not gate ingestion (CLAUDE.md rule 17) and carries no schedule
   * deduction behaviour yet (D7 deferred); it is the hook that phase will build on. */
  stationId: z.string().optional(),
  crs: CrsSchema.optional(),
  /** Opt-in, author-declared id of another `berth` element on this same map (2026-09-11 owner
   * request): a TD-area fringe/boundary pair, where the same physical crossing is reported
   * independently by two describers. Purely a live-map rendering hint — when this berth's and
   * the referenced berth's *current* descriptions are equal and non-null, this berth renders
   * blank (see apps/web/src/map/MapRenderer.tsx / apps/web/src/editor/EditorCanvas.tsx). Never
   * inferred, never touches berth_current_state/berth_occupancy/history/playback, and makes no
   * claim about run identity — CLAUDE.md rule 5's "never assume a berth description uniquely
   * identifies a run" is about resolving *which train*, not about this static, human-declared
   * topology fact. */
  inhibitedBy: z.string().optional(),
});

/** Public rendering is always blank/on/off (red=on, green=off); no aspect calculation
 * (docs/MAP_EDITOR_SPEC.md §5, docs/PROJECT_SPEC.md §6). */
const SignalElementSchema = BaseElementSchema.extend({
  type: z.literal("signal"),
  x: z.number(),
  y: z.number(),
  orientation: z.number().default(0),
  label: z.string().optional(),
  symbolStyle: z.enum(["signal-blank", "signal-on", "signal-off"]).default("signal-blank"),
  trackElementId: z.string().optional(),
  bindingId: z.string().optional(),
  /** ADR 0005 E4: `offset` = a short stem from (x,y) out to a head set off the track (side from
   * `orientation`), OTT-inspired. Absent / `inline` = today's head on the track at (x,y). Both
   * ship so the owner can compare and drop one later. No aspect change either way (rule 9). */
  renderMode: z.enum(["inline", "offset"]).optional(),
});

const PlatformElementSchema = BaseElementSchema.extend({
  type: z.literal("platform"),
  /** ADR 0005 (rev. 2026-09-08): 3+ points are the outline of a **filled** platform shape (so
   * vertices vary its width); a legacy 2-point platform is drawn as a standard-height bar. */
  points: z.array(PointSchema).min(2),
  /** @deprecated ADR 0005 E3 — use a standalone `platformNumber` element. Still parsed for old
   * documents but **no longer rendered**; the editor does not write it. */
  number: z.string().optional(),
  name: z.string().optional(),
  tiploc: z.string().optional(),
  /** ADR 0004 D6: optional bound track. When set, the renderer offsets the platform bar to the
   * far side of that track by the standard gap instead of centring it on its own polyline. */
  trackElementId: z.string().optional(),
  stationId: z.string().optional(),
});

/** ADR 0005 E3: the platform number as an independent, freely-placed item (the author puts it
 * above its platform). Renders as the white bordered box + text. `platformId` is an optional
 * soft link for future grouping; nothing enforces it. Lives on the Platforms layer with a
 * small positive `zIndex` so it paints above the bars. */
const PlatformNumberElementSchema = BaseElementSchema.extend({
  type: z.literal("platformNumber"),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1),
  platformId: z.string().optional(),
  fontSize: z.number().positive().default(10),
});

/** ADR 0004 D6: a named station. Renders its `name` in the standard station-label style; the
 * optional `crs` is the map-authoring hook for the deferred station-berth schedule deduction
 * (D7). A zone bracket around member platforms is later work. */
const StationElementSchema = BaseElementSchema.extend({
  type: z.literal("station"),
  x: z.number(),
  y: z.number(),
  name: z.string().min(1),
  crs: CrsSchema.optional(),
  tiploc: z.string().optional(),
  fontSize: z.number().positive().default(16),
});

const LabelElementSchema = BaseElementSchema.extend({
  type: z.literal("label"),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1),
  // 2026-09-11 owner request: a multi-line label (newlines wrap to stacked lines, both
  // renderers already support centering each line correctly via `textAnchor`/Konva `align` —
  // see MapRenderer.tsx's <tspan> block and EditorCanvas.tsx's `anchoredText`) reads oddly
  // left-aligned by default, and there was previously no editor control to override it per
  // label at all. Defaulting to "center" fixes new labels; existing documents keep whatever
  // they were already saved with (this only changes the default for a value that was never
  // set).
  align: z.enum(["left", "center", "right"]).default("center"),
  fontSize: z.number().positive().default(12),
});

const BoundaryElementSchema = BaseElementSchema.extend({
  type: z.literal("boundary"),
  x: z.number(),
  y: z.number(),
  name: z.string().min(1),
  adjacentMapSlug: z.string().optional(),
  direction: z.string().optional(),
});

export const MapElementSchema = z.discriminatedUnion("type", [
  TrackPathElementSchema,
  BerthElementSchema,
  SignalElementSchema,
  PlatformElementSchema,
  PlatformNumberElementSchema,
  StationElementSchema,
  LabelElementSchema,
  BoundaryElementSchema,
]);

const TopologyNodeSchema = z.object({ id: z.string().min(1), x: z.number(), y: z.number() });
const TopologyEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  trackElementId: z.string().optional(),
});
const TopologySchema = z.object({
  nodes: z.array(TopologyNodeSchema).default([]),
  edges: z.array(TopologyEdgeSchema).default([]),
});

const TdBerthBindingSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  type: z.literal("tdBerth"),
  tdArea: z.string().min(1),
  berth: z.string().min(1),
  /** MAP_EDITOR_SPEC §9: duplicate berth bindings are blocking "unless explicitly allowed and
   * justified" — this is that explicit opt-in. */
  allowDuplicate: z.boolean().default(false),
});

const TdSBitBindingSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  type: z.literal("tdSBit"),
  tdArea: z.string().min(1),
  address: z.string().min(1),
  bit: z.number().int().nonnegative(),
  activeMeans: z.enum(["on", "off"]),
});

export const MapBindingSchema = z.discriminatedUnion("type", [
  TdBerthBindingSchema,
  TdSBitBindingSchema,
]);

export const MapDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  map: MapMetaSchema,
  layers: z.array(LayerSchema).default([]),
  elements: z.array(MapElementSchema).default([]),
  topology: TopologySchema.default({ nodes: [], edges: [] }),
  bindings: z.array(MapBindingSchema).default([]),
  /** Stripped at publication time (docs/MAP_EDITOR_SPEC.md §11) — never part of the compiled bundle. */
  editorMetadata: z.record(z.unknown()).default({}),
});

export type MapDocument = z.infer<typeof MapDocumentSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type MapElement = z.infer<typeof MapElementSchema>;
export type TrackPathElement = z.infer<typeof TrackPathElementSchema>;
export type BerthElement = z.infer<typeof BerthElementSchema>;
export type SignalElement = z.infer<typeof SignalElementSchema>;
export type PlatformElement = z.infer<typeof PlatformElementSchema>;
export type PlatformNumberElement = z.infer<typeof PlatformNumberElementSchema>;
export type StationElement = z.infer<typeof StationElementSchema>;
export type LabelElement = z.infer<typeof LabelElementSchema>;
export type BoundaryElement = z.infer<typeof BoundaryElementSchema>;
export type MapBinding = z.infer<typeof MapBindingSchema>;
export type TdBerthBinding = z.infer<typeof TdBerthBindingSchema>;
export type TdSBitBinding = z.infer<typeof TdSBitBindingSchema>;
export type TopologyNode = z.infer<typeof TopologyNodeSchema>;
export type TopologyEdge = z.infer<typeof TopologyEdgeSchema>;
