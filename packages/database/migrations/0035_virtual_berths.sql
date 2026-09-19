-- docs/adr/0012: virtual (GPS-fed) berths for track with no TD coverage. Occupancy is driven by
-- TRUST movement reports sourced from GPS (packages/domain/src/trust/garnerMovement.ts's
-- originalDataSource decode) rather than TD CA/CB/CC events, so this is deliberately a separate
-- table set keyed by STANOX rather than overloading berth_occupancy/berth_current_state, which
-- are keyed by (td_area, berth_code) throughout — a virtual berth has neither.

-- Widen map_binding_index (migration 0010) for the new binding kind. td_area becomes nullable —
-- a virtual berth binding has no TD area at all.
alter table map_binding_index alter column td_area drop not null;
alter table map_binding_index add column stanox text;

alter table map_binding_index drop constraint map_binding_index_berth_fields_check;
alter table map_binding_index add constraint map_binding_index_berth_fields_check check (
  (binding_type = 'td_berth' and td_area is not null and berth is not null
     and address is null and bit is null and stanox is null)
  or
  (binding_type = 'td_s_bit' and td_area is not null and address is not null and bit is not null
     and berth is null and stanox is null)
  or
  (binding_type = 'virtual_berth' and stanox is not null and td_area is null
     and berth is null and address is null and bit is null and combined_order is null)
);

alter table map_binding_index drop constraint map_binding_index_binding_type_check;
alter table map_binding_index add constraint map_binding_index_binding_type_check
  check (binding_type in ('td_berth', 'td_s_bit', 'virtual_berth'));

-- One row per (map_version, stanox) per binding's STANOX entry (a binding with several STANOXes
-- produces several rows, same "one row per lookup key" shape td_berth already uses).
create unique index map_binding_index_virtual_berth_unique
  on map_binding_index (map_version_id, stanox) where binding_type = 'virtual_berth';

create index map_binding_index_virtual_berth_lookup_idx
  on map_binding_index (stanox) where binding_type = 'virtual_berth';

-- Occupancy intervals per STANOX, partitioned by entered_at month like berth_occupancy
-- (docs/DATA_MODEL.md §11). Parent + default partition only here; concrete month partitions come
-- from packages/database/src/partitions.ts at runtime (see apps/worker/src/commands/
-- ensurePartitions.ts's PARTITIONED_TABLES list, which this migration's companion code change
-- adds this table to).
create sequence virtual_berth_occupancy_id_seq as bigint;

create table virtual_berth_occupancy (
  id bigint not null default nextval('virtual_berth_occupancy_id_seq'),
  projection_version integer not null,
  stanox text not null,
  trust_id text not null,
  -- Display only, from trust_activation_extra/decoded trust_id at entry time — never a join key
  -- back (CLAUDE.md rule 5's spirit: a headcode string is never treated as unique identity; here
  -- trust_id already *is* the identity, headcode is just what's shown).
  headcode text,
  entered_at timestamptz not null,
  left_at timestamptz,
  entry_trust_movement_id bigint not null references trust_movement (id),
  exit_trust_movement_id bigint references trust_movement (id),
  exit_reason text check (
    exit_reason in ('stepped_to_virtual', 'terminated', 'manual_clear', 'superseded')
  ),
  primary key (id, entered_at)
) partition by range (entered_at);

alter sequence virtual_berth_occupancy_id_seq owned by virtual_berth_occupancy.id;
create table virtual_berth_occupancy_default partition of virtual_berth_occupancy default;

create index virtual_berth_occupancy_stanox_idx
  on virtual_berth_occupancy (stanox, entered_at desc);
create index virtual_berth_occupancy_trust_id_idx
  on virtual_berth_occupancy (trust_id, entered_at desc);
-- Idempotency guard for the projector's `on conflict do nothing` inserts, same pattern migration
-- 0008 uses for td_berth_event/td_s_event against redelivered raw broker frames.
create unique index virtual_berth_occupancy_entry_movement_uk
  on virtual_berth_occupancy (entry_trust_movement_id);

-- Map-independent nationwide current state, keyed by (projection_version, stanox) — mirrors
-- berth_current_state's shape/role exactly.
create table virtual_berth_current_state (
  projection_version integer not null,
  stanox text not null,
  trust_id text,
  headcode text,
  occupancy_id bigint,
  occupancy_entered_at timestamptz,
  event_at timestamptz not null,
  source_trust_movement_id bigint not null references trust_movement (id),
  updated_at timestamptz not null default now(),
  primary key (projection_version, stanox),
  constraint virtual_berth_current_state_occupancy_fk
    foreign key (occupancy_id, occupancy_entered_at)
    references virtual_berth_occupancy (id, entered_at)
);
