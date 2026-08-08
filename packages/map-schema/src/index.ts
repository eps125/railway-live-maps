export {
  MAP_SCHEMA_VERSION,
  MapDocumentSchema,
  MapElementSchema,
  MapBindingSchema,
  type MapDocument,
  type MapElement,
  type Layer,
  type TrackPathElement,
  type BerthElement,
  type SignalElement,
  type PlatformElement,
  type LabelElement,
  type BoundaryElement,
  type MapBinding,
  type TdBerthBinding,
  type TdSBitBinding,
  type TopologyNode,
  type TopologyEdge,
} from "./document.js";
export { validateMapDocument, type ValidationIssue, type ValidationResult } from "./validate.js";
export {
  compileMapDocument,
  sortElementsForPaint,
  Z_INDEX_LAYER_BAND,
  type CompiledMapBundle,
} from "./compiler.js";
