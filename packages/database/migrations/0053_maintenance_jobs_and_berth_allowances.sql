-- Milestone 97a (docs/adr/0021): admin-run area maintenance jobs, and the per-berth allowance the
-- held-train delay estimate subtracts.
--
-- 1. `maintenance_job`: a small queue. An admin queues a job from the admin pages (audited); the
--    `worker` container's `serve` role claims one at a time and records progress. Kinds:
--      berth_allowances — recalculate `berth_dwell_profile` for the job's TD areas;
--      link_backfill    — `repair-run-links` over a window for the job's TD areas.
--    Only one job runs at once (partial unique index). A job interrupted by a worker restart is
--    put back in the queue on the next start, up to `max_attempts`.
-- 2. `berth_dwell_profile`: each berth's normal occupancy time with outliers removed. A derived
--    projection of `berth_occupancy` (CLAUDE.md rule 3) — rebuilt by re-running the job.
--
-- New tables only; nothing existing is changed. Re-runnable.

create table if not exists maintenance_job (
  id bigserial primary key,
  kind text not null check (kind in ('berth_allowances', 'link_backfill')),
  td_areas text[] not null check (cardinality(td_areas) > 0),
  params jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  cancel_requested boolean not null default false,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  progress jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint maintenance_job_started_check
    check (status = 'queued' or status = 'cancelled' or started_at is not null),
  constraint maintenance_job_finished_check
    check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null))
);

create index if not exists maintenance_job_queued_idx
  on maintenance_job (requested_at) where status = 'queued';
create index if not exists maintenance_job_requested_at_idx
  on maintenance_job (requested_at desc);
-- At most one running job at a time.
create unique index if not exists maintenance_job_one_running_idx
  on maintenance_job ((true)) where status = 'running';

create table if not exists berth_dwell_profile (
  td_area text not null,
  berth_code text not null,
  -- 'measured': enough occupancies to measure; 'default': too few, so the default allowance.
  basis text not null check (basis in ('measured', 'default')),
  sample_size integer not null check (sample_size >= 0),
  dropped integer not null default 0 check (dropped >= 0 and dropped <= sample_size),
  median_minutes numeric(8, 2),
  q1_minutes numeric(8, 2),
  q3_minutes numeric(8, 2),
  fence_minutes numeric(8, 2),
  allowance_minutes numeric(8, 2) not null check (allowance_minutes > 0),
  window_from timestamptz not null,
  window_to timestamptz not null,
  calculated_at timestamptz not null default now(),
  maintenance_job_id bigint references maintenance_job (id) on delete set null,
  primary key (td_area, berth_code),
  check (window_from < window_to),
  check (basis = 'default' or (median_minutes is not null and fence_minutes is not null))
);
