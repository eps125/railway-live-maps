-- Milestone 36c (docs/IMPLEMENTATION_PLAN.md, docs/adr/0013): S-Class definitions — what each
-- (td_area, address, bit) is (a signal, a route, ...), per area. Reference data authored by the
-- owner (explorer) or imported from published/community tables (wiki, SOP, ECS). It is never used
-- to compute state: a map signal's state still comes only from its explicit `tdSBit` binding
-- (CLAUDE.md rules 9/10); definitions just make those bindings pickable by name.

create table s_class_definition (
  id bigserial primary key,
  td_area text not null,
  -- Canonical two-digit uppercase hex, matching td_s_current_state / td_s_bit_transition.
  address text not null check (address ~ '^[0-9A-F]{2}$'),
  bit smallint not null check (bit between 0 and 7),
  kind text not null
    check (kind in ('signal', 'route', 'points', 'track', 'trts', 'level_crossing', 'unknown')),
  -- e.g. 'S3003' (signal) or 'R1007' (route); null when the bit is known to exist but unidentified.
  label text,
  -- A route's destination (e.g. 'IL1021'); null otherwise.
  destination text,
  source text not null check (source in ('wiki', 'sop', 'ecs', 'observed', 'other')),
  notes text,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint s_class_definition_bit_uk unique (td_area, address, bit)
);

create index s_class_definition_label_idx on s_class_definition (td_area, label);

-- Append-only history of every change (create/update/delete/import), so a definition's past
-- values are never lost when it is corrected — imported community tables contain errors.
create table s_class_definition_revision (
  id bigserial primary key,
  td_area text not null,
  address text not null,
  bit smallint not null,
  action text not null check (action in ('create', 'update', 'delete')),
  previous jsonb,
  next jsonb,
  -- Groups the rows of one paste-import; null for a single edit.
  import_batch text,
  changed_by text not null,
  changed_at timestamptz not null default now()
);

create index s_class_definition_revision_bit_idx
  on s_class_definition_revision (td_area, address, bit, changed_at desc);
