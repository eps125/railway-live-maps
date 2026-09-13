-- Milestone 29 (docs/IMPLEMENTATION_PLAN.md): admin/editor login.
--
-- Owner explicitly rejected both drafted alternatives (a single ADMIN_USERNAME/ADMIN_PASSWORD_HASH
-- env-var credential, and Tailscale-only network access) in favour of a real multi-user, role-based
-- table so more accounts can be added later without a code change. Only two roles exist today
-- (`admin`, `editor`) — the `check` constraint is intentionally narrow and widens with a future
-- migration if a third level (e.g. a read-only "viewer") is ever needed; this table is the source
-- of truth for identity, sessions themselves stay in Redis (CLAUDE.md: "Redis only for ephemeral
-- pub/sub, cache and coordination" — losing sessions on a Redis restart just forces a re-login).
--
-- No table seeds an initial account: the first admin is created via the worker's
-- `manage-users create --username ... --role admin` command (apps/worker/src/commands/manageUsers.ts),
-- run once by hand against the deployed container, matching this repo's existing pattern of
-- operational one-shot CLI commands (publish-map, prune-partitions) rather than a magic bootstrap
-- row or a plaintext credential anywhere in Git.

create table app_user (
  id bigserial primary key,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'editor')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
