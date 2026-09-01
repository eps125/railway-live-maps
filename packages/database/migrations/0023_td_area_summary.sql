-- Live-path hardening (2026-09-01). `GET /api/v1/td/areas` computed min/max(normalized_event_at_utc)
-- + per-message-class counts with a full `group by td_area` scan of `raw_feed_event` on every
-- request — fine at fixture scale, an 11+ minute disk-saturating scan once `raw_feed_event`
-- reached tens of millions of nationwide rows (production incident, 2026-09-01: three concurrent
-- copies of this exact query, each 11+ minutes, starved every other projection of disk I/O).
--
-- A small rollup, maintained incrementally by project-td as it already processes every row
-- (apps/worker/src/td/projector.ts), replaces the scan with a single-row-per-area read. Existing
-- history is populated once by the `backfill-td-area-summary` command
-- (apps/worker/src/commands/backfillTdAreaSummary.ts) — deliberately not done inside this
-- migration, since that backfill *is* the expensive full scan this table exists to stop paying
-- repeatedly; run it once, off-peak, with `projector-td` stopped.
create table td_area_summary (
  td_area text primary key,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  c_class_count bigint not null default 0,
  s_class_count bigint not null default 0,
  updated_at timestamptz not null default now()
);
