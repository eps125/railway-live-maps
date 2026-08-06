/** Milestone 6's optional Redis-backed delta publisher — a downstream projector reading
 * `td_berth_event`, distinct from the `td-berth-and-s-class` projection it reads from. Bump
 * the version if the delta-building logic changes incompatibly with previously-checkpointed
 * progress. */
export const MAP_DELTA_PROJECTION_NAME = "map-delta-publisher";
export const MAP_DELTA_PROJECTION_VERSION = 1;
