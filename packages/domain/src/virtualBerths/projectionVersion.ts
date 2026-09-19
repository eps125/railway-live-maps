/** Shared between apps/worker (which writes virtual_berth_current_state/virtual_berth_occupancy)
 * and apps/api (which reads them), so both always agree on which projection_version's rows are
 * "current" — same role as `TD_PROJECTION_VERSION` (`../td/projectionVersion.js`), but for the
 * separate virtual-berth table set (docs/adr/0012). */
export const VIRTUAL_BERTH_PROJECTION_NAME = "virtual-berth";
export const VIRTUAL_BERTH_PROJECTION_VERSION = 1;
