# ADR 0018 — Map visibility, user groups, regions, access codes and the admin audit log

- **Status:** accepted (owner, 2026-10-01)
- **Date:** 2026-10-01
- **Implemented by:** Milestone 83 (groups, visibility, regions, map list, place search, audit
  log) and Milestone 84 (access codes and site access mode)

## Context

Every published map is visible to everyone, and the site is open to anyone. The owner asked
(2026-10-01) for:

- maps visible only to chosen people (staff, or admins only), with a way to take a public map
  back to staff-only;
- user groups rather than a fixed "staff" flag, so future groups can see different maps;
- the map list sorted alphabetically, optionally grouped by region (an admin setting);
- a place on more than one map, with the visitor choosing which;
- a site mode in which guests need a temporary access code, generated in the admin area, with
  use limits, a fixed access period, revocation, and a log of where each code was used;
- an audit log of admin actions.

## Decision

### 1. User groups

`user_group` (name, description) and `app_user_group` (membership; a user may be in several).
Admins manage both under Admin › Users. Migration 0046 seeds an **Editors** group containing
every existing user, so "staff only" is a one-click choice from day one.

Groups decide only what a user can **see**. Roles (`editor`, `admin`) still decide what a user
can **do**. Admins see every map whatever its visibility.

### 2. Map visibility (per map)

`map.visibility` is `public` or `restricted`. A restricted map is visible to the groups listed in
`map_visibility_group`, to admins, and (Milestone 84) to access codes that name the map. A
restricted map with no groups is admins-only. Changing visibility takes effect immediately, in
both directions (public → restricted is the "revert to staff" case).

Visibility is per map, not per version (owner decision): staff check changes in the editor
preview before publishing.

A map the viewer cannot see answers **404 `MAP_NOT_FOUND`**, never 403, so its existence does
not leak. The check is one hook on every route with a `:slug` — public map routes (definition,
state, delays, events, the live WebSocket) and every editor route, so an editor not in a map's
groups cannot open it in the editor either (owner decision). The map list and place search
filter by the same predicate (`mapVisibilitySql`).

Non-map endpoints (berth history, schedules, current run) are not map-scoped and are unchanged;
Milestone 84's site access mode gates them.

### 3. Regions and the map list

`map_region` (name, sort order), managed under Admin › Maps; each map has an optional region.
`app_setting` holds `map_list_region_grouping` (boolean). When it is on, the landing page groups
maps by region (in region order, then "Other") with an A–Z toggle; when off, the list is A–Z only.
Within any group, maps sort by name, case-insensitively.

Map settings (name, slug, description, region, visibility, delete) move from the landing page to
a new Admin › Maps page. Editors see an "Unpublished maps" list on the landing page for drafts
they can see that have never been published.

### 4. Place search: every map

`GET /api/v1/places/search` returns `maps: [{ slug, name, elementId }]` per place (all visible
maps, by name) instead of one `mapSlug`. The page links straight to a single map, lists the maps
when there are several, and says "not on any map yet" when there are none.

### 5. Admin audit log

`admin_audit_log` records who did what to which item, with details and the client IP. The table
is append-only, enforced by a trigger that rejects `update` and `delete`. Every admin and editor
API action that changes configuration writes one: map create / settings / delete / publish,
user and group changes, region changes, setting changes, and (Milestone 84) access-code and
site-mode changes. Admin › Audit log lists it, newest first, filterable by action and user.

### 6. Access codes (Milestone 84)

- `app_setting.site_access_mode`: `open` (default) or `code_required`.
- **When `code_required`:** a guest with no valid access gets the code entry page at every
  address, with a staff login link. After a valid code they return to the address they asked
  for. Every public API route answers 401 `ACCESS_CODE_REQUIRED`, and the WebSocket is refused.
  Logged-in users are never asked.
- **`access_code`:** label; code (stored so admins can view it again — owner decision; an
  unguessable random value, or custom text); scope (whole site, or a list of maps in
  `access_code_map`); use limit (N or unlimited); access period per use; optional expiry after
  which it cannot be entered; revoked time.
- **Each use is an `access_grant`** with a fixed expiry (entry time + access period; owner chose
  fixed). Admins can change one grant's expiry or revoke it; revoking a code revokes all its
  grants. The browser holds an opaque random token in an `rlm_access` cookie; only its SHA-256
  hash is stored.
- **A code naming specific maps** lets its holder see those maps even when they are restricted
  (owner decision), and in `code_required` mode only those maps.
- **Activity:** first/last seen, IP and user agent per grant, and request counts per grant per
  hour. Admins see a code's uses and activity; a grant seen from several IPs, or a code used from
  several networks, is flagged.
- Code entry is rate-limited per IP. Activity older than 90 days is deleted.
- **Amended 2026-10-01 (owner):** a revoked code can be re-enabled (the uses its revoke ended come
  back); a code can be deleted for good (audited); and an admin can **purge** a code, which also
  removes every audit entry about it, unrecorded. Migration 0049 lets the audit log accept that one
  kind of delete; it stays append-only for everything else.

## Consequences

- Every map route does one extra small query (the map's visibility, and the viewer's groups when
  logged in). Acceptable; it is an indexed lookup on a tiny table.
- The visibility check runs before the `/delays` cache, so a cached answer never leaks.
- A logged-in user's group changes apply on their next request (groups are read from Postgres,
  not stored in the Redis session).
- The audit log grows without pruning; it is small (admin actions only).
