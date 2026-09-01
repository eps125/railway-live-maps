# Initial API and WebSocket Contract

All public endpoints are versioned under `/api/v1`. Times are ISO 8601 UTC in responses; clients render in `Europe/London`.

## 1. Public REST

### `GET /api/v1/maps`

List published maps and live-data status.

### `GET /api/v1/maps/{slug}/definition?at={timestamp}`

Return the compiled map version effective at `at`; default now.

### `GET /api/v1/maps/{slug}/state?at={timestamp}`

Return a complete state snapshot at the requested time.

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

Compact map-relevant events for playback buffering. Cursor pagination; bounded range and result count.

### `GET /api/v1/berths/{tdArea}/{berth}/history?from=&to=&after=&limit=`

Occupancy intervals and playback link data. (The per-occupancy `resolutionStatus` field was
dropped with the berth-run resolver — ADR 0002.)

### `GET /api/v1/descriptions/{description}/history?from=&to=&after=&limit=`

Occurrences across all retained TD areas.

> `GET /api/v1/runs/{runId}` and `GET /api/v1/runs/{runId}/schedule` (Milestone 8) were **removed**
> with RLM's bespoke `train_run` model (ADR 0002, 2026-09-01). Nothing consumed them after
> run-following left the web client. Run↔schedule detail now comes from the garner mirror via the
> `current-run` popup endpoint below.

### `GET /api/v1/status`

Sanitized status of web/API, nationwide feeds, archive durability, projections, schedules, storage pressure and playback.

### `GET /api/v1/td/areas`

List every observed TD area with first/last event times, C-Class/S-Class counts, heartbeat freshness and whether any published map uses it. This is backed by nationwide ingestion, not a configured allow-list.

### `GET /api/v1/td/areas/{area}/berths?observedFrom=&observedTo=&after=&limit=`

List observed berth identifiers and basic activity statistics for map-authoring and diagnostics.

### `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` (Milestone 9; reworked by ADR 0002)

The live map's click-a-berth popup, one round trip (`docs/PROJECT_SPEC.md` §5 "Train/run
popup"). 404 with `error.code: "BERTH_NOT_OCCUPIED"` when the berth has no current occupancy —
matches "click a **populated** berth."

Since ADR 0002 (2026-09-01) RLM has **no berth-run resolver** and does not claim a single train
identity for a berth. The response instead carries, all sourced from the garner (openrail-eps)
mirror: the TD headcode, every `cif_schedules` row whose `signalling_id` equals that headcode and
that runs today (`candidateSchedules`), and — when one can be picked (STP precedence, or a single
`trust_activation` today breaking an STP tie) — the `effective` schedule with its calling points,
`trust_activation` and latest `trust_movement`. `effective` is `null` when the headcode is
ambiguous and nothing is TRUST-activated today. A fixed `note` states this is garner's data, not
an RLM identification.

```json
{
  "tdArea": "PX",
  "berth": "0512",
  "description": "2A16",
  "headcode": "2A16",
  "occupancyEnteredAt": "2026-08-10T10:14:58.000Z",
  "note": "Candidate schedules for this headcode running today, mirrored from openrail-eps ...",
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
    "destinationTiploc": "LANCSTR",
    "destinationName": "Lancaster",
    "selectedBy": "trust_activation",
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
  }
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

## 4. Editor API

Protected/private.

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
