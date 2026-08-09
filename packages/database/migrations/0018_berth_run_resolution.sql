-- Milestone 9 (docs/DATA_MODEL.md §7 `berth_run_resolution`, §8 "Run resolver"): berth-to-run
-- resolution outcomes, one row per occupancy, updated in place as new evidence arrives — same
-- "retained fields, mutable outcome, updated not re-inserted" pattern migration 0015's
-- run_schedule_link already established for TRUST-to-schedule linking.
create table berth_run_resolution (
  id bigserial primary key,
  occupancy_id bigint not null,
  occupancy_entered_at timestamptz not null,
  status text not null check (status in ('matched', 'ambiguous', 'unmatched')),
  selected_train_run_id uuid references train_run (id),
  confidence numeric,
  resolver_version integer not null,
  decided_at timestamptz not null default now(),
  -- [{trainRunId, score, reasons: string[]}, ...] — every candidate considered, not just the
  -- winner, per docs/DATA_MODEL.md §8 "Output all plausible candidates and evidence."
  candidates jsonb not null default '[]',
  -- Reserved for a future manual-override feature (docs/DATA_MODEL.md §7's
  -- "manual override metadata if later supported") — no code in this milestone writes it.
  manual_override jsonb,
  constraint berth_run_resolution_occupancy_fk
    foreign key (occupancy_id, occupancy_entered_at)
    references berth_occupancy (id, entered_at),
  unique (occupancy_id)
);

create index berth_run_resolution_train_run_idx on berth_run_resolution (selected_train_run_id);
