-- Milestone 72 (docs/IMPLEMENTATION_PLAN.md): the Berth explorer's per-berth, per-day activity.
--
-- One row per (TD area, UTC day, berth, source). `events_in` counts events whose to_berth is this
-- berth (CA steps into it, CC interposes); `events_out` counts events whose from_berth is this
-- berth (CA steps out of it, CB cancels). It is a derived projection of `td_berth_event` and can
-- be rebuilt from it (CLAUDE.md rule 3).
--
-- Why a table at all: `td_berth_event` has no berth index, so "which berths were seen in this
-- area in the last 90 days" would read every step of the area in the window (M9 alone is ~5k a
-- day; nationwide ~2M a day). This table makes that a read of a few thousand small rows, and
-- makes a rarely used berth's history findable by telling the API which days to look at.
--
-- `source` separates the two writers, so neither ever overwrites the other's counts:
--   'live'     — `project-td`, additively, in the same transaction that inserts the
--                td_berth_event rows (exactly once per event), for every event past the cutover;
--   'backfill' — `backfill-berth-activity`, absolute per-day recounts of the events at or before
--                the cutover (idempotent, re-runnable).
-- A reader sums both.
create table td_berth_daily_activity (
  td_area text not null,
  activity_date date not null,
  berth text not null,
  source text not null check (source in ('live', 'backfill')),
  events_in integer not null default 0 check (events_in >= 0),
  events_out integer not null default 0 check (events_out >= 0),
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (td_area, activity_date, berth, source),
  check (first_event_at <= last_event_at)
);

-- One berth's active days, newest first — the explorer's step history walks these.
create index td_berth_daily_activity_berth_idx
  on td_berth_daily_activity (td_area, berth, activity_date desc);

-- The ingestion_sequence at which `project-td` started counting (written once, by the first
-- batch it processes after this migration). Everything at or before it is the backfill's job;
-- everything after it is the live counter's. Cleared with the table on a projector rebuild.
create table td_berth_activity_cutover (
  id smallint primary key check (id = 1),
  live_after_sequence bigint not null,
  recorded_at timestamptz not null default now()
);
