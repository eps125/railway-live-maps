-- Milestone 39 (docs/adr/0007): sticky run-lineage matching across berth steps and TD-area
-- boundaries. Three new tables, no changes to any existing table (in particular, no new index on
-- the huge, hot `berth_occupancy`/`td_berth_event` — the projector's lookups reuse the existing
-- `(td_area, berth_code, entered_at desc)` index, narrowing to one berth's rows before filtering
-- further in memory; see apps/worker/src/runLineage/projector.ts).
--
-- Deliberately much thinner than the `train_run`/`train_run_event`/`run_schedule_link` model ADR
-- 0002 removed: this `train_run` is an identity *pointer* into garner-mirrored `cif_schedules`
-- only, never a duplicate of schedule/location content, and carries no backfill/version-bump
-- machinery — just a checkpointed projector, same pattern as every other one in this codebase.

create table train_run (
  id bigserial primary key,
  -- Nullable: a run can, in principle, be established purely from step-chain continuity with no
  -- schedule ever resolved for it (not attempted in this milestone — `currentRun.ts` only ever
  -- writes a link when it has resolved a `cif_schedule_id`), but the column stays nullable rather
  -- than assuming that never happens.
  cif_schedule_id bigint references cif_schedules (id),
  cif_train_uid text not null,
  traffic_day date not null,
  match_basis text not null check (
    match_basis in (
      'trust_activation', 'stp_precedence', 'station_berth_timetable', 'headcode_only',
      'step_chain', 'boundary_correlated'
    )
  ),
  match_confidence text not null check (match_confidence in ('solid', 'weak')),
  established_at timestamptz not null default now(),
  established_td_area text not null,
  established_berth text not null,
  -- Set when fresher evidence (a new TRUST activation, an STP change) contradicts this run —
  -- correction, not silent freezing (docs/adr/0007). Never deleted, so the superseded chain stays
  -- inspectable.
  superseded_by bigint references train_run (id),
  created_at timestamptz not null default now()
);

create index train_run_uid_day_idx on train_run (cif_train_uid, traffic_day);
create index train_run_schedule_idx on train_run (cif_schedule_id) where cif_schedule_id is not null;

-- One row per occupancy interval, pointing at the run it belongs to. `berth_occupancy`'s real
-- primary key is (id, entered_at) — it's partitioned by entered_at — so the FK needs both columns,
-- same pattern `berth_current_state_occupancy_fk` (migration 0008) already uses.
create table berth_occupancy_run_link (
  berth_occupancy_id bigint not null,
  occupancy_entered_at timestamptz not null,
  train_run_id bigint not null references train_run (id),
  link_basis text not null check (link_basis in ('resolved', 'step_chain', 'boundary_correlated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (berth_occupancy_id, occupancy_entered_at),
  constraint berth_occupancy_run_link_occupancy_fk
    foreign key (berth_occupancy_id, occupancy_entered_at)
    references berth_occupancy (id, entered_at)
);

create index berth_occupancy_run_link_train_run_idx on berth_occupancy_run_link (train_run_id);

-- Owner-curated reference data (docs/adr/0007) — never auto-derived or auto-applied from SMART.
-- Entered through a new editor-only admin screen (apps/web/src/auth/TdBoundariesPage.tsx).
-- Undirected in meaning (a physical adjacency between two TD areas' berths); the projector looks
-- it up both ways.
create table td_area_boundary (
  id bigserial primary key,
  area_a text not null,
  berth_a text not null,
  area_b text not null,
  berth_b text not null,
  notes text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (area_a, berth_a, area_b, berth_b)
);
