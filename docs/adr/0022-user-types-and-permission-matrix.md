# ADR 0022 — User types, a permission matrix, and access codes that grant them

- **Status:** accepted (owner, 2026-10-28)
- **Date:** 2026-10-28
- **Supersedes:** the fixed `editor` / `admin` roles of Milestone 29, and the access-code
  `scope` and `site_access_mode` parts of ADR 0018 §6
- **Implemented by:** Milestone 99

## Context

Since Milestone 29 a user has one of two fixed, ordered roles (`editor` < `admin`, compared with
`roleSatisfies` / `roleAtLeast`). Milestones 83–84 added groups (what a user can _see_), map
visibility, and access codes with a scope of `site`, `all_maps` or `maps`, plus a site mode of
`open` or `code_required`.

Every capability was hard-wired to a role:

| Capability                                                                                                         | Gate                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Editor routes (drafts, validate, diff, **publish**, module changes, editor state, S-Class definitions for binding) | `requireRole("editor")`                  |
| Create / rename / delete a map, make a module, republish all                                                       | `requireRole("admin")`                   |
| Users, groups, regions, site settings, audit log, access codes                                                     | `requireRole("admin")`                   |
| TD boundaries, maintenance, berth query/steps, berth explorer, S-Class explorer                                    | `requireRole("admin")`                   |
| Every map, whatever its visibility                                                                                 | `role === "admin"` in `mapVisibilitySql` |
| Feed-gap details (`qualityForViewer`)                                                                              | `role === "admin"`                       |
| Delay explanation in the train popup                                                                               | `role === "admin"`                       |
| Full train popup (schedule, TRUST, candidates, weak matches)                                                       | any session                              |
| Signal numbers toggle, S-Class map panel (web only)                                                                | `isAdmin` in `MapView.tsx`               |
| Admin pages (`ADMIN_ROUTES`), landing-page admin links (web only)                                                  | `isAdmin`                                |
| Playback, delay colours                                                                                            | anyone who can see the map               |

The owner (2026-10-28) asked for admin-editable **user types**, each with a **permission
matrix**, and access codes that grant a user type or a custom permission set, optionally
limited to named maps. Six starting types: No user (public), Basic User, Enhanced User, Editor,
Enhanced Editor, Admin. Each row of the train popup is its own permission, so experimental rows
can be added later and shown to chosen types only.

## Decision

### 1. Permissions are a registry in code, mirrored by a reference table

`packages/database/src/permissions.ts` exports `PERMISSIONS`: each entry has a key, a category,
a label and a description (for the matrix UI), and whether an access code may grant it. The
`permission` table holds the same keys and is the foreign-key target for every stored grant, so
a typo or a removed permission cannot be stored. Adding a permission = a registry entry + a
migration inserting its row (and granting it to whichever types should have it). The API refuses
to start if the registry and the table disagree.

| Key                        | Gates (server side)                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Viewing**                |                                                                                                                                                                               |
| `site.view`                | Using the site at all: map list, place search, berth/schedule/run lookups, the live WebSocket. Without it a visitor gets the login / code page (replaces `site_access_mode`). |
| `maps.view_public`         | Maps whose visibility is `public`.                                                                                                                                            |
| `maps.view_all`            | Every map, restricted ones included (was `role === "admin"` in `mapVisibilitySql`).                                                                                           |
| **Map**                    |                                                                                                                                                                               |
| `map.playback`             | `/maps/:slug/events`, and `?at=` on `/definition`, `/state`, `/delays` and the train popup.                                                                                   |
| `map.delay_colours`        | `/maps/:slug/delays`; delay bands are left out of the WebSocket snapshot and pushes.                                                                                          |
| `map.signal_numbers`       | Signal number labels are stripped from map definitions without it.                                                                                                            |
| `map.feed_gap_details`     | Feed-gap times/areas/reasons (was admins only).                                                                                                                               |
| `map.s_class_panel`        | The S-Class panel on the map, and the read-only S-Class routes it uses.                                                                                                       |
| **Train popup** (each row) | The `current-run` response leaves out every field the viewer may not see.                                                                                                     |
| `popup.headcode`           | Headcode and time entered. Without it the popup is not available at all.                                                                                                      |
| `popup.delay`              | The delay line.                                                                                                                                                               |
| `popup.delay_explanation`  | The delay line's working (was admins only).                                                                                                                                   |
| `popup.origin_destination` | Operator, origin, destination.                                                                                                                                                |
| `popup.calling_points`     | The full schedule table.                                                                                                                                                      |
| `popup.formation`          | Unit allocation.                                                                                                                                                              |
| `popup.schedule`           | Train UID, STP indicator, service code, and origin/destination change details.                                                                                                |
| `popup.match_details`      | How the schedule was picked (`matchStatus`, `matchBasis`, the note).                                                                                                          |
| `popup.weak_matches`       | Ambiguous, unmatched and headcode-only matches (without it these answer 404 `NO_PUBLIC_DETAIL`).                                                                              |
| `popup.candidates`         | The candidate schedules list.                                                                                                                                                 |
| `popup.trust`              | TRUST ID, activation, TOC, WTT ID, identity changes.                                                                                                                          |
| `popup.latest_report`      | The latest TRUST movement report.                                                                                                                                             |
| **Editor**                 |                                                                                                                                                                               |
| `editor.view`              | Opening the editor and reading drafts, revisions, diff, validate, editor state, S-Class definitions for binding.                                                              |
| `maps.edit`                | Saving drafts, berth actions.                                                                                                                                                 |
| `maps.publish`             | Publishing a map or module, applying module changes, republish-all.                                                                                                           |
| `maps.manage`              | Creating, renaming, deleting maps; map settings (visibility, region); regions; making a module.                                                                               |
| **Tools**                  |                                                                                                                                                                               |
| `tools.berth_explorer`     | Berth explorer.                                                                                                                                                               |
| `tools.berth_query`        | Berth query and berth steps.                                                                                                                                                  |
| `tools.s_class`            | S-Class explorer and definitions (read and write).                                                                                                                            |
| `tools.td_boundaries`      | TD boundaries.                                                                                                                                                                |
| `tools.maintenance`        | Area maintenance jobs.                                                                                                                                                        |
| **Admin**                  |                                                                                                                                                                               |
| `admin.users`              | Users and groups.                                                                                                                                                             |
| `admin.user_types`         | User types and the permission matrix.                                                                                                                                         |
| `admin.access_codes`       | Access codes and grants.                                                                                                                                                      |
| `admin.site_settings`      | Site settings.                                                                                                                                                                |
| `admin.audit_log`          | The audit log.                                                                                                                                                                |

The Admin hub and the Berths hub show when the viewer holds any permission behind them.

### 2. User types

`user_type`: id, `system_key` (`public`, `admin`, or null), name, description, sort order,
`grants_all`. `user_type_permission`: (user_type_id, permission), FK to both.

- **Admin** (`system_key = 'admin'`, `grants_all = true`) has every permission, including ones
  added later, without matrix rows. It cannot be deleted, re-permissioned or renamed.
- **No user (public)** (`system_key = 'public'`) is the type of every anonymous visitor. It
  cannot be deleted or assigned to a user or code; its permissions are editable — granting it
  `site.view` + `maps.view_public` opens the site to the public.
- Other types can be created, renamed, re-permissioned and deleted. Deleting a type that users
  or codes still use is refused (409 with the counts).

Seed (owner decisions: map management Admin only; access codes and audit log Admin only, each
on its own permission):

| Permission                                                                                                              | No user | Basic | Enhanced | Editor | Enh. Editor | Admin |
| ----------------------------------------------------------------------------------------------------------------------- | :-----: | :---: | :------: | :----: | :---------: | :---: |
| `site.view`, `maps.view_public`                                                                                         |         |   ✓   |    ✓     |   ✓    |      ✓      |  all  |
| `maps.view_all`                                                                                                         |         |       |    ✓     |   ✓    |      ✓      |       |
| `map.playback`, `map.delay_colours`                                                                                     |         |   ✓   |    ✓     |   ✓    |      ✓      |       |
| `map.signal_numbers`                                                                                                    |         |       |          |   ✓    |      ✓      |       |
| `map.feed_gap_details`, `map.s_class_panel`                                                                             |         |       |          |        |      ✓      |       |
| `popup.headcode`, `popup.delay`, `popup.origin_destination`, `popup.calling_points`, `popup.formation`                  |         |   ✓   |    ✓     |   ✓    |      ✓      |       |
| `popup.schedule`, `popup.match_details`, `popup.weak_matches`, `popup.candidates`, `popup.trust`, `popup.latest_report` |         |       |          |   ✓    |      ✓      |       |
| `popup.delay_explanation`                                                                                               |         |       |          |        |      ✓      |       |
| `editor.view`, `maps.edit`                                                                                              |         |       |          |   ✓    |      ✓      |       |
| `maps.publish`                                                                                                          |         |       |          |        |      ✓      |       |
| `maps.manage`                                                                                                           |         |       |          |        |             |       |
| `tools.*` (5)                                                                                                           |         |       |          |        |      ✓      |       |
| `admin.*` (5)                                                                                                           |         |       |          |        |             |       |

The Basic popup is exactly today's anonymous popup; the Editor popup is today's logged-in one.

### 3. Users

`app_user.user_type_id` (not null, FK, `on delete restrict`). `role` is kept, unread, for one
release so a rollback is possible, then dropped by a later migration with owner approval.

- Permissions are read from Postgres (the whole matrix, cached in-process and cleared on any
  type change; a user's type looked up per request like groups are), not from the Redis
  session, so a change applies on the user's next request.
- Groups still only add _restricted maps shared with that group_, as before.
- **Escalation guard:** a user can only assign a type, or give a code a type or permission set,
  whose permissions they hold themselves; only holders of `admin.user_types` edit the matrix.
- **Lock-out guard:** the last active user holding both `admin.users` and `admin.user_types`
  cannot be deactivated, deleted, or moved to a type without them, and the matrix cannot be
  changed so that no active user holds them.

### 4. Access codes

`access_code` gains `grant_kind` (`user_type` | `custom`), `user_type_id` (required when
`user_type`), `access_code_permission` (code_id, permission) for `custom`, and `map_limit`
(`none` | `maps`). With `maps`, the holder sees exactly the maps in `access_code_map` —
restricted ones included — and no others, whatever the permissions say. A code never opens a
module (unchanged).

- A code may grant editor permissions (owner decision) but never `admin.*`: those need an
  account. Enforced by the registry's `codeGrantable` flag in the API and by a trigger on
  `access_code_permission`; a `user_type` code whose type holds an `admin.*` permission (or is
  Admin) is refused, and so is a later matrix change that would give such a type `admin.*` while
  a code uses it. The code form shows a warning triangle whenever an editor permission is
  selected, because it is an unusual thing to do.
- Changes made through a code are recorded with the actor `code:<label>` (no user id).
- A logged-in user holding a code gets the union of both (as before: "a code can add maps").
- `scope` is kept, unread, for rollback.

### 5. Site access mode becomes the public type

The anonymous visitor is the "No user" type. `code_required` = "No user" lacks `site.view`;
`open` = it holds it. The migration gives "No user" the Basic User set when the site was `open`.
The Site settings toggle remains as a shortcut: `open` adds `site.view` and `maps.view_public` to
the public type, `code_required` removes `site.view`; its other permissions are left as set in
the matrix. The `site_access_mode` row is left in place, unread.

## Migration of existing data (0056)

| Before                             | After                                               |
| ---------------------------------- | --------------------------------------------------- |
| user `role = admin`                | Admin                                               |
| user `role = editor`               | Enhanced Editor (keeps publish; none in production) |
| code `scope = site`                | Basic User, `map_limit = none`                      |
| code `scope = all_maps`            | Enhanced User, `map_limit = none`                   |
| code `scope = maps`                | Basic User, `map_limit = maps` (same map list)      |
| `site_access_mode = open`          | No user gets Basic User's permissions               |
| `site_access_mode = code_required` | No user gets nothing (production today)             |

Production on 2026-10-28: one admin, no editors, six `site` codes, two `all_maps` codes,
`code_required`. Every user and code holder keeps exactly what they could do before.

## Consequences

- Every gated request does one indexed lookup of the user's type (when logged in) plus a cached
  matrix read.
- `requireRole` is replaced by `requirePermission(...)`; every scope in `server.ts` changes.
- Delay bands are filtered per WebSocket connection; signal labels per definition response.
- The `current-run` response has one shape whose fields are present only when permitted
  (replacing the separate public/full shapes).
- The worker's `manage-users` CLI takes `--type <name>` instead of `--role`.
- Rollback: the old columns are still populated as of the migration and the old code ignores the
  new tables.
