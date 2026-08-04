/** Per-child-event parse outcome (docs/DATA_MODEL.md §3, raw_feed_event.parse_status). */
export const PARSE_STATUSES = [
  "parsed",
  "unsupported",
  "malformed",
  "duplicate-redelivery",
] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

/** Frame-level rollup parse outcome (docs/DATA_MODEL.md §3, feed_frame.parse_status). */
export const FRAME_PARSE_STATUSES = ["ok", "partial", "failed"] as const;
export type FrameParseStatus = (typeof FRAME_PARSE_STATUSES)[number];
