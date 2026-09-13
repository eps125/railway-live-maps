-- Owner request (2026-09-13), alongside Milestone 35's popup role-gating: surface real unit/stock
-- allocation on the click-a-berth popup for both logged-in and anonymous visitors, sourced from
-- the operator's openrail-eps ("garner") MariaDB the same way TRUST/schedule data already is
-- (ADR 0002/0006) — a real `train_allocation` table verified against the live instance
-- (383,882 rows at the time of writing), not RLM's own derivation.
--
-- Unlike the epoch-INT-keyed trust_*/cif_schedules tables, garner stores this table's timestamps
-- as real DATE/DATETIME columns — the bridge maps them straight across, no epoch conversion.
-- `id` is garner's own auto-increment PK; kept as RLM's PK too so the mirror is a pure
-- upsert-by-id (same convention as `cif_schedules`). One row per unit per formation — a two-unit
-- working produces two rows sharing (cif_train_uid, headcode, schedule_start_date), distinguished
-- by `position`.
create table train_allocation (
  id bigint primary key,
  cif_train_uid text not null,
  headcode text not null,
  schedule_start_date date not null,
  origin_tiploc text not null,
  origin_dep timestamptz,
  dest_tiploc text not null,
  dest_arr timestamptz,
  unit_no text not null,
  "position" smallint not null default 0,
  fleet_id text not null,
  vehicles text not null,
  reported timestamptz,
  message_id text not null,
  synced_at timestamptz not null default now()
);

-- The popup's lookup key: candidate schedules are already resolved to a `cif_train_uid` +
-- traffic day (docs/adr/0006) — this is the join path from there to allocation rows.
create index train_allocation_uid_date_idx on train_allocation (cif_train_uid, schedule_start_date);
