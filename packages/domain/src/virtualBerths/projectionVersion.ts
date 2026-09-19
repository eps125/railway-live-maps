/** Shared between apps/worker (which writes virtual_berth_current_state/virtual_berth_occupancy)
 * and apps/api (which reads them), so both always agree on which projection_version's rows are
 * "current" — same role as `TD_PROJECTION_VERSION` (`../td/projectionVersion.js`), but for the
 * separate virtual-berth table set (docs/adr/0012). */
export const VIRTUAL_BERTH_PROJECTION_NAME = "virtual-berth";
export const VIRTUAL_BERTH_PROJECTION_VERSION = 1;

/** docs/adr/0012 gap closure (owner request, 2026-09-19): the TD-reentry hand-off pass reads
 * `td_berth_event` (a completely different event stream from `trust_movement`), so it keeps its
 * own independent checkpoint rather than sharing the one above. */
export const VIRTUAL_BERTH_TD_REENTRY_PROJECTION_NAME = "virtual-berth-td-reentry";
export const VIRTUAL_BERTH_TD_REENTRY_PROJECTION_VERSION = 1;
