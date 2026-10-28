-- Milestone 99 (docs/adr/0022): user types and a permission matrix replace the fixed
-- `editor` / `admin` roles; access codes grant a user type or a custom permission set.
--
-- Additive only. `app_user.role`, `access_code.scope` and the `site_access_mode` setting stay in
-- place (still written, no longer read) so the previous release can be rolled back to; a later
-- migration drops them with owner approval. Every existing user and code keeps exactly what it
-- could do before (see the ADR's mapping table).

-- The permission registry's keys (packages/database/src/permissions.ts). Every stored grant
-- references this table, so an unknown permission cannot be stored. The API refuses to start if
-- this list and the code's registry disagree.
create table permission (
  key text primary key,
  constraint permission_key_format check (key ~ '^[a-z_]+\.[a-z_]+$')
);

insert into permission (key) values
  ('site.view'), ('maps.view_public'), ('maps.view_all'),
  ('map.playback'), ('map.delay_colours'), ('map.signal_numbers'), ('map.feed_gap_details'),
  ('map.s_class_panel'),
  ('popup.headcode'), ('popup.delay'), ('popup.delay_explanation'), ('popup.origin_destination'),
  ('popup.calling_points'), ('popup.formation'), ('popup.schedule'), ('popup.match_details'),
  ('popup.weak_matches'), ('popup.candidates'), ('popup.trust'), ('popup.latest_report'),
  ('editor.view'), ('maps.edit'), ('maps.publish'), ('maps.manage'),
  ('tools.berth_explorer'), ('tools.berth_query'), ('tools.s_class'), ('tools.td_boundaries'),
  ('tools.maintenance'),
  ('admin.users'), ('admin.user_types'), ('admin.access_codes'), ('admin.site_settings'),
  ('admin.audit_log');

-- `system_key`: `public` is every anonymous visitor's type; `admin` holds every permission
-- (`grants_all`), including ones added later, with no matrix rows. Neither can be deleted.
create table user_type (
  id bigserial primary key,
  system_key text unique,
  name text not null,
  description text,
  sort_order integer not null default 0,
  grants_all boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_type_name_not_blank check (btrim(name) <> ''),
  constraint user_type_system_key_check check (system_key in ('public', 'admin')),
  constraint user_type_grants_all_admin_only check (grants_all = (system_key is not distinct from 'admin'))
);
create unique index user_type_name_uk on user_type (lower(name));

create table user_type_permission (
  user_type_id bigint not null references user_type (id) on delete cascade,
  permission text not null references permission (key),
  primary key (user_type_id, permission)
);

insert into user_type (system_key, name, description, sort_order, grants_all) values
  ('public', 'No user (public)', 'Anyone not logged in and without an access code.', 0, false),
  (null, 'Basic User', 'Public maps, playback and delay colours; the basic train popup.', 1, false),
  (null, 'Enhanced User', 'Every map; otherwise as Basic User.', 2, false),
  (null, 'Editor', 'Every map, the full train popup and the editor. Cannot publish; no tools.', 3, false),
  (null, 'Enhanced Editor', 'As Editor, plus publishing and the tools. No admin pages.', 4, false),
  ('admin', 'Admin', 'Everything, including permissions added later.', 5, true);

with basic(p) as (
  values ('site.view'), ('maps.view_public'), ('map.playback'), ('map.delay_colours'),
         ('popup.headcode'), ('popup.delay'), ('popup.origin_destination'),
         ('popup.calling_points'), ('popup.formation')
), enhanced(p) as (
  select p from basic union all values ('maps.view_all')
), editor(p) as (
  select p from enhanced union all
  values ('map.signal_numbers'), ('popup.schedule'), ('popup.match_details'),
         ('popup.weak_matches'), ('popup.candidates'), ('popup.trust'), ('popup.latest_report'),
         ('editor.view'), ('maps.edit')
), enhanced_editor(p) as (
  select p from editor union all
  values ('map.feed_gap_details'), ('map.s_class_panel'), ('popup.delay_explanation'),
         ('maps.publish'), ('tools.berth_explorer'), ('tools.berth_query'), ('tools.s_class'),
         ('tools.td_boundaries'), ('tools.maintenance')
)
insert into user_type_permission (user_type_id, permission)
select t.id, x.p from user_type t, basic x where t.name = 'Basic User'
union all select t.id, x.p from user_type t, enhanced x where t.name = 'Enhanced User'
union all select t.id, x.p from user_type t, editor x where t.name = 'Editor'
union all select t.id, x.p from user_type t, enhanced_editor x where t.name = 'Enhanced Editor';

-- The site access mode becomes the public type's permissions: `open` gave guests what Basic
-- User has; `code_required` (production today) gives them nothing.
insert into user_type_permission (user_type_id, permission)
select pub.id, utp.permission
  from user_type pub
  join user_type basic on basic.name = 'Basic User'
  join user_type_permission utp on utp.user_type_id = basic.id
 where pub.system_key = 'public'
   and coalesce((select value #>> '{}' from app_setting where key = 'site_access_mode'), 'open')
       = 'open';

-- Users: admin -> Admin; editor -> Enhanced Editor (keeps publishing, which editors had).
alter table app_user add column user_type_id bigint references user_type (id) on delete restrict;
update app_user u set user_type_id = t.id
  from user_type t
 where t.name = case u.role when 'admin' then 'Admin' else 'Enhanced Editor' end;
alter table app_user alter column user_type_id set not null;
create index app_user_user_type_idx on app_user (user_type_id);
-- A user is never the anonymous type.
create function app_user_type_not_public() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from user_type where id = new.user_type_id and system_key = 'public') then
    raise exception 'a user cannot have the public user type';
  end if;
  return new;
end;
$$;
create trigger app_user_type_not_public
  before insert or update of user_type_id on app_user
  for each row execute function app_user_type_not_public();

-- Access codes: a user type, or a custom permission set; optionally limited to named maps.
alter table access_code
  add column grant_kind text not null default 'user_type',
  add column user_type_id bigint references user_type (id) on delete restrict,
  add column map_limit text not null default 'none',
  add constraint access_code_grant_kind_check check (grant_kind in ('user_type', 'custom')),
  add constraint access_code_map_limit_check check (map_limit in ('none', 'maps'));
create index access_code_user_type_idx on access_code (user_type_id);

update access_code c set
  user_type_id = t.id,
  map_limit = case c.scope when 'maps' then 'maps' else 'none' end
  from user_type t
 where t.name = case c.scope when 'all_maps' then 'Enhanced User' else 'Basic User' end;

-- Added after the backfill above, so existing codes satisfy it.
alter table access_code add constraint access_code_user_type_required check (
  (grant_kind = 'user_type') = (user_type_id is not null)
);

-- A code may grant editor permissions (owner decision) but never an admin one, and never the
-- public or Admin type: those need an account (the public type is not a grant at all).
create table access_code_permission (
  code_id bigint not null references access_code (id) on delete cascade,
  permission text not null references permission (key),
  primary key (code_id, permission),
  constraint access_code_permission_not_admin check (permission !~ '^admin\.')
);

create function access_code_type_grantable() returns trigger
language plpgsql as $$
begin
  if new.user_type_id is not null and exists (
    select 1 from user_type t
     where t.id = new.user_type_id
       and (t.system_key is not null
            or exists (select 1 from user_type_permission p
                        where p.user_type_id = t.id and p.permission ~ '^admin\.'))
  ) then
    raise exception 'an access code cannot grant the public type, Admin, or a type with admin permissions';
  end if;
  return new;
end;
$$;
create trigger access_code_type_grantable
  before insert or update of user_type_id on access_code
  for each row execute function access_code_type_grantable();

-- ... and a type a code uses cannot later be given an admin permission.
create function user_type_permission_code_safe() returns trigger
language plpgsql as $$
begin
  if new.permission ~ '^admin\.' and exists (
    select 1 from access_code where user_type_id = new.user_type_id
  ) then
    raise exception 'user type % is granted by an access code and cannot hold admin permissions',
      new.user_type_id;
  end if;
  return new;
end;
$$;
create trigger user_type_permission_code_safe
  before insert on user_type_permission
  for each row execute function user_type_permission_code_safe();
