-- Audit trail for manual operator berth actions (currently just "clear"), triggered from the
-- private editor UI (EDITOR_ENABLED-gated) when a berth is stuck showing a stale description —
-- e.g. after a feed connection gap silently dropped the real step/clear event. Deliberately NOT
-- consulted by apps/worker/src/td/projector.ts's `project-td --rebuild`: current state stays a
-- pure derived projection of raw_feed_event (CLAUDE.md rule 3), so a manual clear is a live-only
-- override that a rebuild will not replay — this table exists purely so every such override has
-- a durable, queryable record of who/when/why, never a silent edit with no trace (CLAUDE.md "do
-- not silently repair source data").
create table operator_berth_action (
  id bigserial primary key,
  td_area text not null,
  berth_code text not null,
  action_type text not null check (action_type in ('clear')),
  reason text not null,
  performed_at timestamptz not null default now(),
  closed_occupancy_id bigint,
  closed_occupancy_entered_at timestamptz,
  constraint operator_berth_action_closed_occupancy_fk
    foreign key (closed_occupancy_id, closed_occupancy_entered_at)
    references berth_occupancy (id, entered_at)
);

create index operator_berth_action_area_berth_idx
  on operator_berth_action (td_area, berth_code, performed_at desc);
