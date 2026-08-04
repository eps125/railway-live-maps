/** Nationwide subscribed source feeds (docs/ARCHITECTURE.md §4). */
export const FEED_NAMES = ["TD", "TRUST", "VSTP"] as const;
export type FeedName = (typeof FEED_NAMES)[number];
