/** Every normalized row must retain lineage to its source raw event (CLAUDE.md engineering rules). */
export interface SourceLineage {
  rawEventId: string;
  /** Denormalized copy of raw_feed_event.normalized_event_at_utc — required for the composite FK
   * into the partitioned raw_feed_event table (Postgres requires partition-key columns in FKs). */
  rawEventNormalizedAtUtc: string;
  ingestionSequence: string;
}
