-- Milestone 7 (docs/IMPLEMENTATION_PLAN.md): tracks every downloaded/imported SCHEDULE/CORPUS/
-- SMART file — one row per complete file, referencing its archived body
-- (docs/ARCHITECTURE.md §4: "Archive and import complete permitted... datasets... preserve
-- source version, checksum and import lineage").
--
-- unique(source_kind, checksum_sha256) recognizes a byte-identical re-download/re-import as
-- the same file rather than a new one — the "complete-file checksums" acceptance bullet.
-- `is_active` is only meaningful for `schedule_full` (the full-file swap importer flips it);
-- corpus/smart importers upsert in place and look up "current" via
-- `order by completed_at desc where status='completed' limit 1` instead.
create table source_file_import (
  id bigserial primary key,
  source_kind text not null check (source_kind in ('schedule-file', 'reference-file')),
  file_kind text not null check (file_kind in ('schedule_full', 'corpus', 'smart')),
  archive_object_id bigint not null references raw_archive_object (id),
  checksum_sha256 text not null,
  effective_date date,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  row_counts jsonb not null default '{}',
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
  error_summary text,
  is_active boolean not null default false,
  unique (source_kind, checksum_sha256)
);

create index source_file_import_file_kind_idx on source_file_import (file_kind, completed_at desc);
