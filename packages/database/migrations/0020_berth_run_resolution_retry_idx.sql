-- Milestone 9 follow-up: apps/worker/src/resolver/projector.ts's retry pass filters
-- `status != 'matched' order by decided_at asc limit ...` on every run — without an index
-- matching that exact access pattern, this forces a full scan/sort of berth_run_resolution,
-- which grows without bound (nationwide, every occupancy ever resolved). A partial index scoped
-- to exactly the rows the retry pass ever looks at keeps that query cheap regardless of how much
-- history has accumulated.
create index berth_run_resolution_retry_idx on berth_run_resolution (decided_at)
  where status != 'matched';
