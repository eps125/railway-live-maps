/** Shared between apps/worker (which writes these projections) and apps/api (which reads them),
 * so both always agree on which projection_version's rows are "current". */
export const TD_PROJECTION_NAME = "td-berth-and-s-class";
export const TD_PROJECTION_VERSION = 1;
