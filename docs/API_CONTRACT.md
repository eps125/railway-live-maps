# Initial API and WebSocket Contract

All public endpoints are versioned under `/api/v1`. Times are ISO 8601 UTC in responses; clients render in `Europe/London`.

## 1. Public REST

### `GET /api/v1/maps`

List published maps and live-data status.

### `GET /api/v1/maps/{slug}/definition?at={timestamp}`

Return the compiled map version effective at `at`; default now.

### `GET /api/v1/maps/{slug}/state?at={timestamp}`

Return a complete state snapshot at the requested time. `at` within ~5 s of now → `mode:
"live"` (current projection). `at` in the past → `mode: "historical"`: a deterministic
reconstruction from `berth_occupancy` (Milestone 10) using the map version **effective at
`at`**; repeated identical requests return byte-identical `berths`/`signals`/`sourceSequence`.
`at` in the future → `400 INVALID_TIME_RANGE`. `quality.gaps` lists `feed_gap` warnings
overlapping/near `at`; `quality.status` is `"stale"` when a gap actually covers `at`.

Response outline:

```json
{
  "mapSlug": "lancaster",
  "mapVersion": 1,
  "asOf": "2026-08-04T12:15:30Z",
  "sourceSequence": 123456,
  "mode": "live",
  "quality": { "status": "ok", "gaps": [] },
  "berths": {
    "berth-element-id": {
      "description": "1S97",
      "enteredAt": "2026-08-04T12:15:28Z"
    }
  },
  "signals": {
    "signal-element-id": { "state": "blank" }
  }
}
```

> The berth-run resolver was removed (ADR 0002, 2026-09-01). Berth state no longer carries a
> `runSummary`, and there is no `run.resolution.updated` live message. Run↔schedule correlation
> is deferred to a later phase that will source it from the garner (openrail-eps) `trust_*`
> mirror rather than a bespoke RLM resolver.

### `GET /api/v1/maps/{slug}/events?from=&to=&after=&limit=`

Compact map-relevant events for playback buffering (Milestone 10). Each entry is the **same
wire shape as a live WS `berth.updated` / `berth.cleared` delta**, so the playback client
applies them with its live-delta code path. One `td_berth_event` (a CA) can yield two entries
(`from` clears, `to` updates); entries for the map's bound berths only. Ordered by
`ingestion_sequence`; `after` is that cursor; `from`/`to` bound the range (max 7 days). Uses the
map version effective at `from`.

```json
{
  "mapSlug": "lancaster",
  "mapVersion": 1,
  "events": [
    {
      "type": "berth.updated",
      "sequence": 123457,
      "eventAt": "2026-08-04T12:15:38Z",
      "elementId": "berth-1",
      "tdArea": "PX",
      "berth": "1008",
      "description": "1S97",
      "enteredAt": "2026-08-04T12:15:38Z"
    }
  ],
  "nextCursor": "123457"
}
```

### `GET /api/v1/berths/{tdArea}/{berth}/history?from=&to=&after=&limit=`

Occupancy intervals and playback link data. (The per-occupancy `resolutionStatus` field was
dropped with the berth-run resolver — ADR 0002.)

### `GET /api/v1/descriptions/{description}/history?from=&to=&after=&limit=`

Occurrences across all retained TD areas.

> `GET /api/v1/runs/{runId}` and `GET /api/v1/runs/{runId}/schedule` (Milestone 8) were **removed**
> with RLM's bespoke `train_run` model (ADR 0002, 2026-09-01). Nothing consumed them after
> run-following left the web client. Run↔schedule detail now comes from the garner mirror via the
> `current-run` popup endpoint below.

### `GET /api/v1/places/search?q=` (Milestone 31)

Nationwide place search, public/no session required. Matches `q` against `location_reference`
(CORPUS-sourced) by name/CRS/TIPLOC/STANOX, left-joined against `map_place_index` restricted to
each map's currently-effective version. `400 VALIDATION_ERROR` for a missing/blank `q`; `limit`
optional (default 20, max 50). Returns
`{ results: [{ tiploc, stanox, crs, name, mapSlug, elementId }] }` — `mapSlug`/`elementId` are
`null` when nothing currently published covers that place (inert, not an error). A result with a
map jumps straight to `/map/{mapSlug}?center={elementId}` in the web app, which centers the public
renderer's initial view on that element.

### `GET /api/v1/status`

Sanitized status of web/API, nationwide feeds, archive durability, projections, schedules, storage pressure and playback.

### `GET /api/v1/td/areas`

List every observed TD area with first/last event times, C-Class/S-Class counts, heartbeat freshness and whether any published map uses it. This is backed by nationwide ingestion, not a configured allow-list.

### `GET /api/v1/td/areas/{area}/berths?observedFrom=&observedTo=&after=&limit=`

List observed berth identifiers and basic activity statistics for map-authoring and diagnostics.

### `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` (Milestone 9; rebuilt Milestone 34/35, docs/adr/0006)

The live map's click-a-berth popup, one round trip (`docs/PROJECT_SPEC.md` §5 "Train/run
popup"). 404 with `error.code: "BERTH_NOT_OCCUPIED"` when the berth has no current occupancy —
matches "click a **populated** berth."

The berth-run resolver ADR 0002 removed (2026-09-01) was rebuilt on garner (openrail-eps) data by
ADR 0006 (2026-09-13, Milestones 34/35) — query-time only, no persisted resolution table or
daemon. Candidate `cif_schedules` rows (`signalling_id` equals the berth's TD headcode, running
today) are **position-scoped** first — narrowed to schedules calling at a TIPLOC this berth's
SMART data (`smart_berth_step`) says is plausible — before any tie-break runs; only when a berth
has no SMART coverage at all does the search fall back to the unscoped nationwide headcode match,
the weakest `headcode_only` tier. `matchStatus` is always exactly one of `matched`, `ambiguous` or
`unmatched` (CLAUDE.md rule 7 — reinstated by Milestone 34, never silently resolved); `matchBasis`
says which tier produced it (`trust_activation` > `stp_precedence` > `station_berth_timetable` >
`headcode_only`, ADR 0004 D7's ranking — plus `step_chain` / `boundary_correlated`, Milestone 39,
docs/adr/0007, when the match came from inherited lineage rather than this request's own
headcode/position search; see below). `station_berth_timetable` (Milestone 35) only applies to
a position-scoped berth: when STP precedence alone leaves more than one tied candidate, it's
broken by whichever candidate's scheduled calling time at that station is closest to _now_ — not
to when the berth was entered (a headcode is often interposed hours before its scheduled
departure, whenever the train is physically present) and with no "already passed" exclusion (a
nominally-past time might just mean the train is running late, not that the working finished).
`positionScoped` says whether SMART-derived scoping was used at all. `effective` (the picked
schedule's calling points, `trust_activation`, latest `trust_movement`) is present only when
`matchStatus` is `matched`; `candidateSchedules` lists whichever set was actually considered
(position-scoped or the unscoped fallback). A `note` states the basis in plain language, always
naming this as garner's data, not a confirmed RLM identification.

**Current, not just scheduled (Milestone 49, docs/adr/0009):** `effective.originTiploc`/
`originName`/`destinationTiploc`/`destinationName` and each entry in `effective.locations` are the
run's **current** origin/destination/calling points — overridden from the static schedule's
LO/LT/calling-point TIPLOCs when garner has mirrored a TRUST Change of Origin, Change of Location,
or a part-cancellation (read as the run's new effective destination — TRUST has no dedicated
"change of destination" message; owner-confirmed reading, 2026-09-17) for it. `effective.locations`
never marks a revised calling point specially (no strikethrough, no "was" text) — it's simply
replaced in place; that treatment is deliberately different from openrail's own `/rail/livetrain`
detail page, which strikes the old value through instead. `effective.activation.trustId` stays the
_original_ activation's own TRUST id even after a Change of Identity — the run's current id is
`effective.identityChange.newTrustId` when present. Movement/latest-report lookups (`latestMovement`)
follow a Change of Identity to the new id automatically. Full/authenticated response only:
`effective.originChange`/`destinationChange` (`{ previousTiploc, previousName, changedAt, reason }`,
`null` when nothing changed) and `effective.identityChange`
(`{ previousTrustId, newTrustId, changedAt }`, `null` when the identity hasn't changed) — omitted
from the anonymous/reduced shape below along with every other TRUST/resolver-internal field.

**Role-gated response (owner request, same day):** a logged-in session (any role) gets the full
shape below. An anonymous request (no session cookie — viewing the map itself never needs one)
gets `404 NO_PUBLIC_DETAIL` unless the match is **solid** — the weakest `headcode_only` tier is
excluded, since its own note already says to verify it. On a solid match, an anonymous request
instead gets a reduced shape: just
`{ tdArea, berth, headcode, occupancyEnteredAt, matchStatus: "matched", effective:
{ originTiploc, originName, destinationTiploc, destinationName, operatorCode, locations } | null,
unitAllocation }` — no `note`, `matchBasis`, `positionScoped`, `candidateSchedules`, or any of
`effective`'s TRUST/CIF/movement fields. `note`'s "matched by TRUST activation/STP precedence/
verify this" language is resolver-internal and meaningless without `matchBasis` to read it
against, so it stays on the full (logged-in) response only (owner request, 2026-09-14). This is
enforced server-side (the response itself is shaped differently), not left to the UI to hide.

**Sticky run-lineage matching (Milestone 39, docs/adr/0007):** before running the resolver above
at all, the route checks whether the berth's currently open occupancy already carries a run link
— established by an earlier click here, or inherited by `run-lineage-daemon` from a berth this
train physically stepped from (`matchBasis: "step_chain"`) or across an owner-curated TD-area
boundary crossing (`matchBasis: "boundary_correlated"`). If so, `effective` is built directly from
that linked schedule and headcode/position resolution is skipped entirely for this request.
"Solid" for the anonymous gate above then follows the link's own inherited confidence (capped at
whatever produced it originally — inheriting from a `headcode_only` match stays weak downstream,
never upgrades) rather than being re-derived from `matchBasis` alone. A real (non-lineage) match
always establishes or corrects the link afterward so a later physical step can carry it forward;
a lineage-shortcut match never rewrites it, so its `step_chain`/`boundary_correlated` provenance
isn't lost. Every field on this response otherwise behaves identically regardless of which path
produced the match.

**Unit/stock allocation (owner request, same day), shown to every visitor regardless of login:**
`unitAllocation` — an array, one entry per **currently allocated** unit in the formation (ordered
by `position`), mirrored from garner's `train_allocation` (migration 0031): `{ unitNo, position,
fleetId, vehicles: [...], reportedAt }`. `train_allocation` is an append-only log of allocation
_reports_ — a unit reallocated by control produces a new row per report, not an update to the old
one — so this endpoint returns only the most recently reported row per `position` (fixed
2026-09-15; see `docs/IMPLEMENTATION_PLAN.md` Milestone 35's follow-up #6), never every historical
report. Empty when garner has nothing allocated for the matched train today.

```json
{
  "tdArea": "PX",
  "berth": "0512",
  "description": "2A16",
  "headcode": "2A16",
  "occupancyEnteredAt": "2026-08-10T10:14:58.000Z",
  "matchStatus": "matched",
  "matchBasis": "trust_activation",
  "positionScoped": true,
  "note": "Matched by garner's TRUST activation for a schedule scoped to schedules calling near this berth (SMART data) — not a confirmed RLM identification.",
  "candidateSchedules": [
    {
      "scheduleId": "4210031",
      "trainUid": "U12345",
      "stpIndicator": "P",
      "source": "GARNER",
      "operatorCode": "NT",
      "signallingId": "2A16",
      "scheduleStartDate": "2026-01-01",
      "scheduleEndDate": "2026-12-31",
      "activatedToday": true,
      "trustId": "729S93MT10",
      "activationDeduced": false,
      "isEffective": true
    }
  ],
  "effective": {
    "scheduleId": "4210031",
    "trainUid": "U12345",
    "stpIndicator": "P",
    "source": "GARNER",
    "operatorCode": "NT",
    "originTiploc": "PRST",
    "originName": "Preston",
    "originChange": null,
    "destinationTiploc": "LANCSTR",
    "destinationName": "Lancaster",
    "destinationChange": null,
    "identityChange": null,
    "activation": {
      "trustId": "729S93MT10",
      "deduced": false,
      "activatedAt": "2026-08-10T09:30:00.000Z",
      "trainUid": "U12345",
      "tocId": "NT",
      "scheduleWttId": "U12345",
      "scheduleType": "P",
      "originDepartureAt": "2026-08-10T10:00:00.000Z"
    },
    "latestMovement": {
      "trustId": "729S93MT10",
      "locStanox": "11224",
      "locName": "Preston",
      "platform": "4",
      "actualTimestamp": "2026-08-10T10:01:00.000Z",
      "eventKind": "departure",
      "variationStatus": "late",
      "variationMinutes": 3,
      "terminated": false,
      "offRoute": false
    },
    "locations": [
      {
        "seqNo": 1,
        "locationType": "origin",
        "tiploc": "PRST",
        "locationName": "Preston",
        "...": "..."
      }
    ]
  },
  "unitAllocation": [
    {
      "unitNo": "465029",
      "position": 1,
      "fleetId": "465/0",
      "vehicles": ["64787", "72084", "72085", "64837"],
      "reportedAt": "2026-08-10T09:00:00.000Z"
    }
  ]
}
```

### `GET /api/v1/td/areas/{area}/s-class/events?from=&to=&after=&limit=`

Protected/diagnostic endpoint for retained S-Class source events. Lancaster may return data absence while other areas remain available. Apply strict range limits.

### `GET /api/v1/schedule/{trainUid}?date=YYYY-MM-DD` (Milestone 7; garner-backed since ADR 0002)

Resolves the STP-effective schedule for a `train_uid` on a given traffic day, via
`packages/domain`'s `resolveStpPrecedence` (`C` > `O` > `N` > `P`). Backed by the garner
`cif_schedules` / `cif_schedule_locations` mirror (`source` is always `GARNER`);
origin/destination TIPLOC are derived from the first/last calling point. `date` is required. Per
CLAUDE.md rule 7, the response's top-level `outcome` is always exactly one of `matched`,
`ambiguous` or `unmatched` — never silently resolved.

`matched` (200):

```json
{
  "outcome": "matched",
  "schedule": {
    "trainUid": "1S97",
    "scheduleStartDate": "2026-01-01",
    "scheduleEndDate": "2026-12-31",
    "stpIndicator": "P",
    "daysRunsBitmask": "1111100",
    "signallingId": "2A16",
    "operatorCode": "NT",
    "trainServiceCode": "22222000",
    "trainCategory": null,
    "trainStatus": "P",
    "powerType": "EMU",
    "originTiploc": "PRST",
    "destinationTiploc": "LANCSTR",
    "source": "GARNER"
  },
  "locations": [
    {
      "seqNo": 1,
      "locationType": "origin",
      "tiploc": "PRST",
      "departurePublic": "1000",
      "...": "..."
    },
    {
      "seqNo": 2,
      "locationType": "destination",
      "tiploc": "LANCSTR",
      "arrivalPublic": "1030",
      "...": "..."
    }
  ]
}
```

`ambiguous` (200 — two or more same-precedence candidates both cover the date, never picked
arbitrarily):

```json
{
  "outcome": "ambiguous",
  "candidates": [{ "trainUid": "1S97", "stpIndicator": "P", "...": "..." }]
}
```

`unmatched` (404 — no candidate's date range/days-runs bitmask covers `date`):

```json
{ "outcome": "unmatched" }
```

A `train_uid` never seen at all is a plain 404 with the standard error envelope
(`error.code: "SCHEDULE_NOT_FOUND"`), distinct from a seen-but-not-running-that-day
`unmatched` result.

### `GET /api/v1/vstp/schedules?atocCode=&before=&limit=` (Milestone 7; garner-backed since ADR 0002)

Nationwide short-term-planning schedule discovery/diagnostics, mirroring what
`GET /api/v1/td/areas` gives TD: browse everything captured rather than needing an already-known
`train_uid`. Backed by the garner `cif_schedules` mirror, filtered to `cif_stp_indicator <> 'P'`
(STP overlays/new/cancellations — garner merges NR VSTP into `cif_schedules`, so there is no
separate `source = 'VSTP'` marker any more). Ordered most-recent-first by `id`; `before` (an
opaque `id` cursor from the previous response's `nextCursor`) pages backward in time. `atocCode`
filters to a single operator (garner's `atoc_code`).

```json
{
  "schedules": [
    {
      "id": "1042",
      "trainUid": "Z12345",
      "scheduleStartDate": "2026-08-07",
      "scheduleEndDate": "2026-08-07",
      "stpIndicator": "N",
      "daysRunsBitmask": "1111100",
      "signallingId": "1A23",
      "operatorCode": "GW",
      "trainServiceCode": "12345600",
      "trainCategory": "XX",
      "trainStatus": "P",
      "powerType": "EMU",
      "originTiploc": "PADTON",
      "destinationTiploc": "BRSTLTM",
      "createdAt": "2026-08-07T12:00:00.000Z"
    }
  ],
  "nextCursor": "1041"
}
```

## 2. Live WebSocket

Endpoint:

`GET /api/v1/maps/{slug}/live`

On connection, server sends a complete snapshot:

```json
{
  "type": "snapshot",
  "protocolVersion": 1,
  "sequence": 123456,
  "state": {}
}
```

Then ordered deltas:

```json
{
  "type": "berth.updated",
  "sequence": 123457,
  "eventAt": "2026-08-04T12:15:38Z",
  "elementId": "berth-1",
  "tdArea": "${CONFIRMED_PRESTON_AREA_ID}",
  "berth": "1008",
  "description": "1S97",
  "enteredAt": "2026-08-04T12:15:38Z"
}
```

`berth.updated` no longer carries a `runSummary` and there is no `run.resolution.updated`
message — both were removed with the berth-run resolver (ADR 0002, 2026-09-01). Run↔schedule
correlation on the live map is deferred to a later garner-sourced phase.

Other messages:

- `berth.cleared`
- `quality.updated`
- future `signal.updated`
- `heartbeat`
- `resync.required`

The client tracks `sequence`. On a gap it discards uncertain deltas and fetches a fresh state snapshot.

## 3. Playback client behavior

1. Request map definition and state at target time.
2. Request an event buffer after target time.
3. Advance a local playback clock and apply ordered compact events.
4. Fetch the next buffer before exhaustion.
5. On a new arbitrary seek, cancel old requests and repeat.
6. Live WebSocket remains separate; switching to live fetches a fresh live snapshot before accepting deltas.

## 4a. Auth and admin API

Milestone 29. Roles: `admin`, `editor` (`admin` satisfies any `editor`-gated route too).

- `POST /api/v1/auth/login` — body `{ username, password }`. Rate-limited per-IP and
  per-normalized-username (fixed window). On success sets the `rlm_session` HttpOnly/SameSite=Lax
  cookie (an opaque server-side session token, not a JWT — nothing in it to decode or forge) and
  returns `{ username, role }`. `401` on bad credentials or an inactive account (same generic
  message either way — doesn't reveal which). `429` with `Retry-After` and
  `details.retryAfterSeconds` when rate-limited.
- `POST /api/v1/auth/logout` — clears the session (idempotent; `204` even with no session).
- `GET /api/v1/auth/me` — `{ username, role }` for the current session, `401` if not logged in.
  Used by the frontend to decide whether to show the Editor/Users nav links at all.
- `GET /api/v1/admin/users` (admin only) — `{ users: [...] }`, no password hashes.
- `POST /api/v1/admin/users` (admin only) — body `{ username, password, role }`. `400` for a
  missing/short (<8 char) password or invalid role; `409 DUPLICATE_USERNAME` for an existing one.
- `PATCH /api/v1/admin/users/{id}` (admin only) — body may include any of `role`, `isActive`,
  `password`; only the given fields change. `409 LAST_ADMIN` if the change would leave the system
  with no active admin at all (demoting, deactivating, or — via `DELETE` below — removing the last
  one). `404` for an unknown id.
- `DELETE /api/v1/admin/users/{id}` (admin only) — `204` on success, `404` if already gone, same
  `409 LAST_ADMIN` guard as `PATCH`.

There is no self-registration and no password-reset flow — the first admin account is created via
the worker's `manage-users create --role admin` one-shot CLI (no bootstrap row, no env-var
credential — see `docs/ARCHITECTURE.md` §12); every account after that is managed through the
admin-only "Users" page (`/admin/users` in the web app), which is this same API.

**TD-area boundaries (Milestone 39, docs/adr/0007), admin only:** owner-curated reference data
`run-lineage-daemon` uses to correlate a matched run across a TD-area crossing — never auto-derived
or auto-applied, this API is the only way a pair gets in.

- `GET /api/v1/admin/td-boundaries` — `{ boundaries: [{ id, areaA, berthA, areaB, berthB, notes,
createdBy, createdAt }] }`.
- `POST /api/v1/admin/td-boundaries` — body `{ areaA, berthA, areaB, berthB, notes? }`, all four
  area/berth fields required non-empty strings. `409 DUPLICATE_BOUNDARY` for an existing
  `(areaA, berthA, areaB, berthB)` pair.
- `DELETE /api/v1/admin/td-boundaries/{id}` — `204` on success, `404` if already gone.

Managed through the admin-only "TD boundaries" page (`/admin/td-boundaries` in the web app), which
is this same API.

## 4. Editor API

**Protected (Milestone 29, see §4a):** every route below requires a valid session at the `editor`
role or higher. A request with no session gets `401`; a session below the required role gets
`403` (in practice `editor` is the lowest role, so any logged-in user passes this particular
gate — `403` only shows up on the admin-only routes in §4a and `POST /api/v1/editor/maps` below).

- `POST /api/v1/editor/maps` (**admin only**, Milestone 30) — body `{ slug, name }`. `slug` must
  be lowercase letters/digits/single-hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`); `400 VALIDATION_ERROR`
  for a missing/malformed `slug` or a missing/empty `name`; `409 DUPLICATE_SLUG` if the slug is
  already taken (the existing map is left untouched). Creates the `map` row and seeds its initial
  empty `map_draft` (same blank scaffold `GET .../draft` would otherwise seed on first access, just
  named after the new map instead of the slug) in one step, returning
  `{ slug, name, mapId, draftRevision }`. The map has no published version yet, so it does not
  appear in `GET /api/v1/maps` until its first publish.
- `PATCH /api/v1/editor/maps/{slug}` (**admin only**, owner request 2026-09-13) — rename a map's
  `name` and/or `slug`. Body `{ name?, slug? }`, at least one required; `400 VALIDATION_ERROR` for
  neither given or an invalid one, `404 MAP_NOT_FOUND` for an unknown slug, `409 DUPLICATE_SLUG` if
  the new slug is already taken (original left untouched). Also updates the map's `map_draft` row
  (its own denormalized `slug` column, plus `canonical_document.map.id`/`map.name`) so the next
  draft save/publish — and the editor's own Properties panel, if open — see the new values.
  Renaming the slug changes the map's public URL; anything that already linked to the old
  `/map/{slug}` (bookmarks, a `label`'s `adjacentMapSlug` cross-reference from another map) is not
  rewritten. Returns `{ mapId, slug, name }`.
- `DELETE /api/v1/editor/maps/{slug}` (**admin only**, owner request 2026-09-13) — permanently
  deletes the map row, every published `map_version`, its `map_draft` and draft revision history,
  and the derived `map_binding_index`/`map_place_index`/`map_state_snapshot` rows for those
  versions. `404 MAP_NOT_FOUND` for an unknown slug; `204` on success. Never touches nationwide
  TD/TRUST/etc. event tables (CLAUDE.md rule 17) — only this map's own configuration.
- `GET /api/v1/editor/maps/{slug}/draft`
- `PUT /api/v1/editor/maps/{slug}/draft` with optimistic revision check
- `GET /api/v1/editor/maps/{slug}/revisions`
- `POST /api/v1/editor/maps/{slug}/validate`
- `POST /api/v1/editor/maps/{slug}/publish`
- `GET /api/v1/editor/maps/{slug}/diff?fromVersion=&toRevision=`
- `GET /api/v1/editor/bindings/td/{area}/{berth}/diagnostics`
- `GET /api/v1/editor/state/{slug}?at=`
- `POST /api/v1/editor/berths/{tdArea}/{berth}/clear` with body `{ "reason": string }` (added
  post-Milestone-12): manually clears a berth stuck showing a stale description, most likely
  after a feed connection gap silently dropped its real step/clear event. A live-only override of
  `berth_current_state`/`berth_occupancy` — recorded in `operator_berth_action` for audit, but
  **not** replayed by `project-td --rebuild` (current state stays a pure derived projection of
  `raw_feed_event` per CLAUDE.md rule 3). Returns `{ tdArea, berth, cleared, previousDescription }`
  — `cleared: false` when the berth was already clear (not an error, idempotent).

Draft writes include `expectedRevision`; conflicting updates return `409` with current revision.

## 5. Error format

```json
{
  "error": {
    "code": "INVALID_TIME_RANGE",
    "message": "The requested time range exceeds the permitted limit.",
    "requestId": "...",
    "details": {}
  }
}
```

Do not expose stack traces publicly.

## 6. Rate and range controls

Configurable defaults:

- public state/map endpoints: moderate per-IP limit
- history search: stricter limit
- maximum history range per request: 7 days initially
- cursor pagination required for large results
- WebSocket connection and message-rate limits
- editor payload maximum appropriate for map JSON
