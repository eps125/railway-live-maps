export {
  PARSE_STATUSES,
  FRAME_PARSE_STATUSES,
  type ParseStatus,
  type FrameParseStatus,
} from "./parseStatus.js";
export { FEED_NAMES, type FeedName } from "./feedName.js";
export { ARCHIVE_SOURCE_KINDS, type ArchiveSourceKind } from "./archiveSourceKind.js";
export {
  TD_MESSAGE_CLASSES,
  type TdMessageClass,
  TD_C_CLASS_MESSAGE_TYPES,
  type TdCClassMessageType,
} from "./tdMessageClass.js";
export type { SourceLineage } from "./lineage.js";
export {
  applyCA,
  applyCB,
  applyCC,
  type OpenOccupancySnapshot,
  type BerthEffect,
  type BerthReducerResult,
  type ApplyCAInput,
  type ApplyCBInput,
  type ApplyCCInput,
} from "./td/berthReducer.js";
export { TD_NORMALIZATION_VERSION } from "./td/normalizationVersion.js";
export { TD_PROJECTION_NAME, TD_PROJECTION_VERSION } from "./td/projectionVersion.js";
export {
  MAP_DELTA_PROJECTION_NAME,
  MAP_DELTA_PROJECTION_VERSION,
} from "./mapDelta/projectionVersion.js";
export {
  VSTP_NORMALIZATION_VERSION,
  VSTP_PROJECTION_NAME,
  VSTP_PROJECTION_VERSION,
} from "./vstp/vstpNormalizationVersion.js";
export {
  selectEffectiveSchedule,
  type ScheduleCandidate,
  type StpPrecedenceResult,
} from "./schedule/resolveStpPrecedence.js";
export {
  mapToScheduleRow,
  type ScheduleSourceRecord,
  type ScheduleSourceLocation,
  type ScheduleRowValues,
  type ScheduleLocationRowValues,
  type ScheduleLocationType,
  type MappedSchedule,
} from "./schedule/mapToScheduleRow.js";
export {
  applyActivation,
  applyMovement,
  applyCancellation,
  applyReinstatement,
  applyChangeOfOrigin,
  applyChangeOfLocation,
  applyChangeOfIdentity,
  applyUnidentified,
  type TrainRunLifecycleState,
  type TrainRunSnapshot,
  type TrustRunEffect,
  type TrustReducerResult,
  type ApplyActivationInput,
  type RunLookupInput,
  type ApplyChangeOfIdentityInput,
  type ApplyUnidentifiedInput,
} from "./trust/runReducer.js";
export { computeServiceDate } from "./trust/serviceDate.js";
export {
  extractMovementReport,
  runningIndicationText,
  type MovementReport,
} from "./trust/runningIndication.js";
export {
  decodeTrustMovementFlags,
  signedVariationMinutes,
  type DecodedTrustMovementFlags,
  type TrustMovementEventKind,
  type TrustMovementVariation,
} from "./trust/garnerMovement.js";
export {
  TRUST_NORMALIZATION_VERSION,
  TRUST_PROJECTION_NAME,
  TRUST_PROJECTION_VERSION,
} from "./trust/trustNormalizationVersion.js";
// The berth-run resolver (`./resolver/`) was removed by ADR 0002 (2026-09-01) — run↔schedule
// correlation is deferred to a later phase built on garner's data. See docs/adr/0002 and
// docs/IMPLEMENTATION_PLAN.md Milestone 15.
