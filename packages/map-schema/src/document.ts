import { z } from "zod";
import { MAP_STYLE } from "./style.js";

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
  /** Owner request (2026-09-16): the point the public renderer centres on for a visitor with no
   * remembered view yet (a landing-page click-through, or the "Reset view" button) — distinct
   * from the bounding-box centre `defaultView` falls back to when unset. Author-set in the editor
   * only; never inferred. An explicit `centerElementId`/`centerBoundaryName` (a places-search or
   * boundary-link click-through) still takes priority over this — see MapRenderer.tsx. */
  homePoint: PointSchema.optional(),
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

/**
 * Milestone 55: the placed-label fields every piece of map furniture shares — `neutralSection`,
 * `tunnel`, `viaduct`, `water` and `levelCrossing`. Declared once rather than copied per type, so
 * the editor, both renderers and `placedLabelAnchor` can treat "a shape with an optional caption"
 * uniformly.
 *
 * `labelOffset` detaches the label from its `labelPosition` anchor (owner request 2026-09-20,
 * first added to `neutralSection`): an offset from the **centre of the element's own bounds**, so
 * a detached label still travels with its shape and survives copy/paste. While set,
 * `labelPosition` is ignored but retained, so re-attaching restores the side last chosen.
 */
const placedLabelFields = {
  label: z.string().optional(),
  labelPosition: z.enum(["above", "below", "left", "right"]).default("below"),
  labelOffset: PointSchema.optional(),
  fontSize: z.number().positive().default(MAP_STYLE.placedLabel.fontSize),
};

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
 * (D7). A zone bracket around member platforms is later work. Milestone 31: `stanox` added
 * alongside the pre-existing `crs`/`tiploc` — all three are place identifiers a station can carry
 * for the nationwide place search, not rendered on their own. */
const StationElementSchema = BaseElementSchema.extend({
  type: z.literal("station"),
  x: z.number(),
  y: z.number(),
  /** Owner request 2026-09-20: newlines stack the name into centred lines, exactly as a `label`
   * already does — long station names ("Lancaster Castle Junction") need the vertical space on a
   * crowded schematic. Both renderers split on a newline; a trailing `[CRS]`, when set, goes on
   * the **last** line so it reads as part of the name rather than floating on its own row. */
  name: z.string().min(1),
  crs: CrsSchema.optional(),
  tiploc: z.string().optional(),
  stanox: z.string().optional(),
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
  /** Milestone 31 (owner request): the same place identifiers `station` already carries, so a
   * junction (which gets a plain `label`, not a `station`) is searchable by name/CRS/TIPLOC/STANOX
   * too, not just stations. Metadata only — not rendered, same as a station's `tiploc`/`stanox`. */
  crs: CrsSchema.optional(),
  tiploc: z.string().optional(),
  stanox: z.string().optional(),
  /** Milestone 32, folded into `label` 2026-09-13 (owner request — the dedicated `boundary`
   * element type below is legacy-only from here on; a boundary is now just a label carrying
   * these fields, rendered in the normal label style rather than a distinct marker). Setting
   * `adjacentMapSlug` makes this label clickable on the public map, jumping to
   * `/map/<adjacentMapSlug>` centred on that map's own label/boundary of `adjacentBoundaryName`
   * (falling back to this label's own `text` when unset) — see `MapRenderer.tsx`. */
  adjacentMapSlug: z.string().optional(),
  adjacentBoundaryName: z.string().optional(),
  direction: z.string().optional(),
});

/** Legacy — superseded 2026-09-13 by `label`'s `adjacentMapSlug`/`adjacentBoundaryName`/
 * `direction` fields (owner request: "boundary labels not their own thing anymore", preferring
 * the normal label visual style). Kept parseable/renderable only so already-published immutable
 * map versions (docs/CLAUDE.md rule 11) that still contain `boundary` elements keep working; no
 * longer offered as an editor tool, so no new ones can be authored. */
const BoundaryElementSchema = BaseElementSchema.extend({
  type: z.literal("boundary"),
  x: z.number(),
  y: z.number(),
  name: z.string().min(1),
  adjacentMapSlug: z.string().optional(),
  direction: z.string().optional(),
  /** Milestone 32: the name this same physical boundary is called on the adjacent map. Not
   * assumed to equal this element's own `name` — real signalling boundaries are typically named
   * from each side's own perspective (e.g. one map's "Carlisle PSB" is the other map's "Preston
   * PSB" for the identical crossing), so the correspondence is an explicit author-entered field
   * rather than implicit same-naming. Falls back to this element's own `name` when unset, for the
   * rare case the two sides do happen to coincide. */
  adjacentBoundaryName: z.string().optional(),
});

/**
 * Milestone 53 (owner request 2026-09-20): an AC neutral section, drawn as the real lineside
 * board — Sign **AJ02 Issue 1**, "Neutral Section Indication Board" (RSSB, June 2015), black
 * symbol on white, reproduced to that drawing's own proportions by `neutralSectionGeometry`.
 *
 * Authored map furniture and nothing more: no binding, no live state, no projection, and no
 * operational meaning is read from or attributed to it (CLAUDE.md rules 9/10) — the same
 * standing as a `label`. It is deliberately the *generic* shape for the lineside-feature family
 * the owner has flagged as coming next (tunnels, viaducts, signal boxes): a point, a scale, and
 * an optional placed label, with only the symbol itself specific to this sign.
 */
const NeutralSectionElementSchema = BaseElementSchema.extend({
  type: z.literal("neutralSection"),
  /** The **centre** of the board (unlike a berth's top-left), so changing `size` grows the sign
   * evenly about the placed point rather than pulling it off the track it sits on. */
  x: z.number(),
  y: z.number(),
  /** Side of the square board, in map units. */
  size: z.number().positive().default(MAP_STYLE.neutralSection.size),
  /** Optional caption beside the board (e.g. the neutral section's name or mileage), attached
   * to one side or detached to a free offset — see `placedLabelFields`, which owns these and
   * which `tunnel`/`viaduct`/`water`/`levelCrossing` share. */
  ...placedLabelFields,
});

/**
 * Milestone 55 (owner request 2026-09-20): track in tunnel, drawn as a reshapeable polygon
 * exactly like `platform` — the author traces the bore over the track it covers. Placed with
 * `zIndex: -1` so it paints **below** the rails (see `defaultElementForTool`); the conventional
 * layer stack has no layer under Track, and a negative nudge inside the layer is the documented
 * way to sink an element without one (see `sortElementsForPaint`).
 *
 * Scenery, not signalling: no binding, no live state, nothing inferred (CLAUDE.md rules 9/10).
 */
const TunnelElementSchema = BaseElementSchema.extend({
  type: z.literal("tunnel"),
  points: z.array(PointSchema).min(3),
  ...placedLabelFields,
});

/**
 * Milestone 55: a viaduct deck. Drawn like a `trackPath` — a polyline the author runs along the
 * line — but wider and stone-coloured, and placed with `zIndex: -1` on the Track layer so the
 * rails visibly run *over* the deck. Deliberately **not** welded by `weldTrackPaths` and never
 * part of `topology`: it is scenery that happens to follow the track, not track.
 */
const ViaductElementSchema = BaseElementSchema.extend({
  type: z.literal("viaduct"),
  points: z.array(PointSchema).min(2),
  /** Deck width in map units (owner request 2026-09-20). Optional so a viaduct authored before
   * it existed still parses; `viaductWidth()` supplies the default for those. */
  width: z.number().positive().optional(),
  ...placedLabelFields,
});

/**
 * Milestone 55: water — a river, dock or coastline, as a reshapeable polygon. Any orientation
 * (a river crossing the railway at right angles is the common case, but nothing restricts it).
 * `zIndex: -1`, so the railway crosses over the water.
 */
const WaterElementSchema = BaseElementSchema.extend({
  type: z.literal("water"),
  points: z.array(PointSchema).min(3),
  ...placedLabelFields,
});

/**
 * Milestone 55 (owner request 2026-09-20): a level crossing — the road drawn across the railway.
 *
 * `x`/`y` is the point on the track the road crosses; `orientation` is the road's angle in
 * degrees, 0 meaning "square across a horizontal track" (the usual case) and anything else
 * letting the author match a skewed crossing. `roadLength` runs across the track, `roadWidth`
 * along it.
 *
 * Barriers are **optional and never inferred** (ADR 0014, extending ADR 0013's rule-10 discipline
 * from signals to barriers): a crossing shows barrier positions only when bound to an S-Class bit
 * via a `tdSBitBarrier` binding, and shows nothing at all otherwise. Nothing about train
 * movements, routes, timetables or adjacent signals ever decides a barrier's position.
 */
const LevelCrossingElementSchema = BaseElementSchema.extend({
  type: z.literal("levelCrossing"),
  x: z.number(),
  y: z.number(),
  /** Degrees. 0 = the road runs square across a horizontal track. */
  orientation: z.number().default(0),
  /** Extent of the road across the track. */
  roadLength: z.number().positive().default(MAP_STYLE.levelCrossing.roadLength),
  /** Width of the road, measured along the track. */
  roadWidth: z.number().positive().default(MAP_STYLE.levelCrossing.roadWidth),
  trackElementId: z.string().optional(),
  /** Author's note on the crossing type (MCB, AHB, UWC …). Metadata only — never rendered as a
   * claim about how the crossing is worked, and it does not affect the barrier display. */
  crossingType: z.string().optional(),
  /** Milestone 59 (owner decision 2026-09-21): the realistic drawing (asphalt, centreline,
   * red/white banded arms, picket skirt — `realisticLevelCrossingGeometry`) is now the **default**
   * for every crossing, bound or not; this opts one crossing back into the plain schematic lines,
   * e.g. where the realistic drawing is too busy. Replaces Milestone 58's opt-in
   * `realisticBarriers`, which no longer has any effect (an old document carrying it simply parses
   * with the field dropped, and is realistic by default anyway). */
  schematicBarriers: z.boolean().optional(),
  ...placedLabelFields,
});

export const MapElementSchema = z.discriminatedUnion("type", [
  TrackPathElementSchema,
  BerthElementSchema,
  SignalElementSchema,
  PlatformElementSchema,
  PlatformNumberElementSchema,
  StationElementSchema,
  LabelElementSchema,
  NeutralSectionElementSchema,
  TunnelElementSchema,
  ViaductElementSchema,
  WaterElementSchema,
  LevelCrossingElementSchema,
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
  /** Owner request 2026-09-17: a "combined berth" — up to 4 `tdBerth` bindings sharing one
   * `elementId` for a physical split-berth group used for permissive working (e.g. a 3- or
   * 4-way platform split with no room to draw each member separately). Author-declared only,
   * same "explicit opt-in" precedent as `allowDuplicate`/`inhibitedBy`: every binding sharing an
   * `elementId` must carry a distinct `combinedOrder` (1-4) for the group to be valid
   * (validate.ts), and a lone binding must NOT set it. The renderer joins the currently-occupied
   * members' descriptions in this order (docs/MAP_EDITOR_SPEC.md's berth section). */
  combinedOrder: z.number().int().min(1).max(4).optional(),
});

const TdSBitBindingSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  type: z.literal("tdSBit"),
  tdArea: z.string().min(1),
  /** S-Class byte address in hex (one or two digits; compiled to canonical `"0A"` form). Milestone
   * 36c tightened this (and `bit` to 0-7) — no document had a tdSBit binding before then. */
  address: z.string().regex(/^[0-9A-Fa-f]{1,2}$/, "address must be 1-2 hex digits"),
  bit: z.number().int().min(0).max(7),
  /** What a set bit means: most signal bits are set when the signal is *not* at its most
   * restrictive aspect, i.e. `"off"` (green). Verified per binding, never assumed (ADR 0013). */
  activeMeans: z.enum(["on", "off"]),
});

/**
 * Milestone 55 / ADR 0014: a level crossing's barrier position from one S-Class bit. Structurally
 * identical to `tdSBit` (same area/address/bit), but with the barrier's own vocabulary for what a
 * set bit means, so an author never has to think of a barrier in signal terms. Kept a separate
 * binding type rather than widening `tdSBit.activeMeans` so the "a signal's bit means on/off"
 * invariant stays exactly as ADR 0013 left it.
 *
 * As with a signal, `activeMeans` is verified per binding and never assumed — and the displayed
 * position is always and only this bit's value (rule 10).
 */
const TdSBitBarrierBindingSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  type: z.literal("tdSBitBarrier"),
  tdArea: z.string().min(1),
  address: z.string().regex(/^[0-9A-Fa-f]{1,2}$/, "address must be 1-2 hex digits"),
  bit: z.number().int().min(0).max(7),
  /** What a set bit means for this crossing's barriers. */
  activeMeans: z.enum(["up", "down"]),
});

/**
 * Milestone 59 / ADR 0015 (owner decision 2026-09-21): a level crossing whose barrier position is
 * **inferred** from the signals protecting it — for an area whose feed publishes signals but no
 * crossing bit (e.g. M9's Carleton crossing, from S3879 and S3870).
 *
 * Each input is one signal bit with its own `activeMeans` in the *signal's* vocabulary (what a set
 * bit means for that signal), verified per input exactly as for a `tdSBit` binding. Inputs are
 * bits rather than references to signal elements, so a crossing can be inferred without the
 * signals themselves being drawn. The combination is fixed (`inferredBarrierState`): down if any
 * input signal is off, up only when every input is confirmed on, otherwise blank.
 *
 * Mutually exclusive with a `tdSBitBarrier` binding on the same crossing: a crossing has one
 * barrier source or none.
 */
const InferredBarrierInputSchema = z.object({
  tdArea: z.string().min(1),
  address: z.string().regex(/^[0-9A-Fa-f]{1,2}$/, "address must be 1-2 hex digits"),
  bit: z.number().int().min(0).max(7),
  /** What a set bit means for this *signal* — on M9, set means off (ADR 0014's polarity check). */
  activeMeans: z.enum(["on", "off"]),
  /** Author's note naming the signal (e.g. "S3879"). Not used in the inference. */
  label: z.string().optional(),
});

const TdSBitBarrierInferredBindingSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  type: z.literal("tdSBitBarrierInferred"),
  inputs: z.array(InferredBarrierInputSchema).min(1).max(6),
});

export const MapBindingSchema = z.discriminatedUnion("type", [
  TdBerthBindingSchema,
  TdSBitBindingSchema,
  TdSBitBarrierBindingSchema,
  TdSBitBarrierInferredBindingSchema,
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
export type NeutralSectionElement = z.infer<typeof NeutralSectionElementSchema>;
export type TunnelElement = z.infer<typeof TunnelElementSchema>;
export type ViaductElement = z.infer<typeof ViaductElementSchema>;
export type WaterElement = z.infer<typeof WaterElementSchema>;
export type LevelCrossingElement = z.infer<typeof LevelCrossingElementSchema>;
export type BoundaryElement = z.infer<typeof BoundaryElementSchema>;
export type MapBinding = z.infer<typeof MapBindingSchema>;
export type TdBerthBinding = z.infer<typeof TdBerthBindingSchema>;
export type TdSBitBinding = z.infer<typeof TdSBitBindingSchema>;
export type TdSBitBarrierBinding = z.infer<typeof TdSBitBarrierBindingSchema>;
export type TdSBitBarrierInferredBinding = z.infer<typeof TdSBitBarrierInferredBindingSchema>;
export type InferredBarrierInputDoc = z.infer<typeof InferredBarrierInputSchema>;
export type TopologyNode = z.infer<typeof TopologyNodeSchema>;
export type TopologyEdge = z.infer<typeof TopologyEdgeSchema>;
