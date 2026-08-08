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
});

const PlatformElementSchema = BaseElementSchema.extend({
  type: z.literal("platform"),
  points: z.array(PointSchema).min(2),
  number: z.string().optional(),
  name: z.string().optional(),
  tiploc: z.string().optional(),
});

const LabelElementSchema = BaseElementSchema.extend({
  type: z.literal("label"),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1),
  align: z.enum(["left", "center", "right"]).default("left"),
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
export type LabelElement = z.infer<typeof LabelElementSchema>;
export type BoundaryElement = z.infer<typeof BoundaryElementSchema>;
export type MapBinding = z.infer<typeof MapBindingSchema>;
export type TdBerthBinding = z.infer<typeof TdBerthBindingSchema>;
export type TdSBitBinding = z.infer<typeof TdSBitBindingSchema>;
export type TopologyNode = z.infer<typeof TopologyNodeSchema>;
export type TopologyEdge = z.infer<typeof TopologyEdgeSchema>;
