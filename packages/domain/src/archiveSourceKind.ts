/** raw_archive_object.source_kind (docs/DATA_MODEL.md §3). */
export const ARCHIVE_SOURCE_KINDS = [
  "broker-frame",
  "schedule-file",
  "reference-file",
  "export",
  "backup",
] as const;
export type ArchiveSourceKind = (typeof ARCHIVE_SOURCE_KINDS)[number];
