-- Milestone 83 (docs/adr/0018): user groups, per-map visibility, map regions, site settings and
-- the admin audit log. Additive only — every existing map stays public, every existing user keeps
-- their role, and nothing nationwide is touched.

-- User groups decide what a user can *see* (roles still decide what they can *do*). A user may be
-- in several groups.
create table user_group (
  id bigserial primary key,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_group_name_not_blank check (btrim(name) <> '')
);
create unique index user_group_name_uk on user_group (lower(name));

create table app_user_group (
  user_id bigint not null references app_user (id) on delete cascade,
  group_id bigint not null references user_group (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, group_id)
);
create index app_user_group_group_idx on app_user_group (group_id);

-- "Staff only" from day one: an Editors group holding every existing user.
insert into user_group (name, description)
values ('Editors', 'Everyone who edits maps. Created with Milestone 83.');
insert into app_user_group (user_id, group_id)
select u.id, g.id from app_user u cross join user_group g where g.name = 'Editors';

-- Regions group the public map list (when the admin setting is on).
create table map_region (
  id bigserial primary key,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint map_region_name_not_blank check (btrim(name) <> '')
);
create unique index map_region_name_uk on map_region (lower(name));

-- Visibility is per map (owner decision, 2026-10-01). `restricted` with no groups means admins
-- only; admins always see every map.
alter table map
  add column visibility text not null default 'public',
  add column region_id bigint references map_region (id) on delete set null,
  add constraint map_visibility_check check (visibility in ('public', 'restricted'));

create table map_visibility_group (
  map_id bigint not null references map (id) on delete cascade,
  group_id bigint not null references user_group (id) on delete cascade,
  primary key (map_id, group_id)
);
create index map_visibility_group_group_idx on map_visibility_group (group_id);

-- Small key/value store for admin-changeable site settings (`map_list_region_grouping`, and
-- Milestone 84's `site_access_mode`). Values are jsonb so each setting keeps its own type.
create table app_setting (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into app_setting (key, value) values ('map_list_region_grouping', 'false'::jsonb);

-- Who changed what. Append-only: the trigger below rejects any update or delete, so the log can
-- be trusted as a record (CLAUDE.md: use database constraints for invariants). Actors are stored
-- by id *and* username, with no foreign key, so deleting a user never rewrites history.
create table admin_audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id bigint,
  actor_username text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  client_ip text
);
create index admin_audit_log_occurred_idx on admin_audit_log (occurred_at desc, id desc);
create index admin_audit_log_action_idx on admin_audit_log (action, id desc);

create function admin_audit_log_reject_change() returns trigger
language plpgsql as $$
begin
  raise exception 'admin_audit_log is append-only';
end;
$$;

create trigger admin_audit_log_append_only
  before update or delete on admin_audit_log
  for each row execute function admin_audit_log_reject_change();
