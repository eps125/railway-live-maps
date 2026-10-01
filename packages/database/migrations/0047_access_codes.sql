-- Milestone 84 (docs/adr/0018 §6): temporary guest access codes, and the site access mode.
--
-- An admin creates a code; each time someone enters it, an `access_grant` is created that lasts a
-- fixed time from entry (owner decision: fixed, not sliding; an admin may change a grant's expiry
-- or revoke it afterwards). Codes are kept viewable (owner decision), so `code` is stored as
-- entered/generated; `code_normalized` (upper case, no spaces or dashes) is what entry matches.
-- The browser holds only an opaque random token per grant; its SHA-256 hash is stored here.

create table access_code (
  id bigserial primary key,
  label text not null,
  code text not null,
  code_normalized text not null,
  -- `site`: the public maps (and, in code_required mode, the site). `maps`: only the maps in
  -- `access_code_map` — including restricted ones (owner decision).
  scope text not null,
  -- Null: unlimited uses.
  max_uses integer,
  use_count integer not null default 0,
  -- How long each use grants access for.
  access_seconds integer not null,
  -- After this the code can no longer be entered (existing grants run to their own expiry).
  valid_until timestamptz,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  constraint access_code_label_not_blank check (btrim(label) <> ''),
  constraint access_code_scope_check check (scope in ('site', 'maps')),
  constraint access_code_max_uses_check check (max_uses is null or max_uses > 0),
  constraint access_code_use_count_check check (
    use_count >= 0 and (max_uses is null or use_count <= max_uses)
  ),
  constraint access_code_access_seconds_check check (access_seconds > 0),
  constraint access_code_normalized_format check (code_normalized ~ '^[A-Z0-9]{4,32}$')
);
create unique index access_code_normalized_uk on access_code (code_normalized);

create table access_code_map (
  code_id bigint not null references access_code (id) on delete cascade,
  map_id bigint not null references map (id) on delete cascade,
  primary key (code_id, map_id)
);
create index access_code_map_map_idx on access_code_map (map_id);

create table access_grant (
  id bigserial primary key,
  code_id bigint not null references access_code (id),
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  first_ip text,
  first_user_agent text,
  last_seen_at timestamptz,
  last_ip text
);
create unique index access_grant_token_hash_uk on access_grant (token_hash);
create index access_grant_code_idx on access_grant (code_id, created_at desc);

-- Requests per grant per hour per IP, so an admin can spot one use shared between people.
-- Pruned after 90 days by the API.
create table access_grant_activity (
  grant_id bigint not null references access_grant (id) on delete cascade,
  hour timestamptz not null,
  ip text not null,
  user_agent text,
  request_count integer not null default 0,
  primary key (grant_id, hour, ip)
);
create index access_grant_activity_hour_idx on access_grant_activity (hour);

insert into app_setting (key, value) values ('site_access_mode', '"open"'::jsonb)
on conflict (key) do nothing;
