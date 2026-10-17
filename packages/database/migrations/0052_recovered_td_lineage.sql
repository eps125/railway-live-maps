-- ADR 0020: TD recovered from a secondary capture (openrail-eps tddb-detail.log) after the
-- 2026-10-16 failed CT 116 cutover attempt.
--
-- 1. `raw_feed_event.recovery_source`: NULL for every NR broker-frame row (all existing rows). Set
--    only on rows rebuilt from a non-NR capture, holding the verbatim source line and its
--    provenance. The TD projectors skip rows where it is set: they fold strictly in
--    ingestion_sequence order, and recovered rows carry new sequences but old event times. The
--    import tool writes their derived rows itself. Adding a nullable column with no default is
--    catalog-only on PostgreSQL 11+ (no rewrite, no scan), so it is safe on the ~200 GB partitioned
--    table while ingest runs.
-- 2. `raw_archive_object.source_kind` gains 'recovered-log', the archived source file itself. The
--    old check is replaced NOT VALID: every existing row already satisfies the wider check, and NOT
--    VALID skips the full-table validation scan, so live archive inserts are never blocked.
--
-- Not destructive and re-runnable: no row is changed or removed.

alter table raw_feed_event add column if not exists recovery_source jsonb;

-- 3. `td_berth_event.recovered`: run-lineage and the map-delta projector tail td_berth_event by
--    ingestion_sequence. Recovered steps (new sequences, old event times) would otherwise be
--    published to live maps as if they were current, and chained into run lineage out of order.
--    A constant default is a catalog-only "fast default" (PostgreSQL 11+), so no rewrite of the
--    partitioned table. Playback and history queries read by event time and include these rows.
alter table td_berth_event add column if not exists recovered boolean not null default false;

comment on column raw_feed_event.recovery_source is
  'ADR 0020: NULL = NR broker frame. Set = rebuilt from a secondary capture (source, file, line, '
  'line number). TD projectors skip these rows; their derived rows are written by the import tool.';

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where rel.relname = 'raw_archive_object'
      and nsp.nspname = current_schema()
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%source_kind%'
  loop
    execute format('alter table raw_archive_object drop constraint %I', constraint_name);
  end loop;
end $$;

alter table raw_archive_object
  add constraint raw_archive_object_source_kind_check
  check (source_kind in ('broker-frame', 'schedule-file', 'reference-file', 'export', 'backup', 'recovered-log'))
  not valid;
