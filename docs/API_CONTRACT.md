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
      "enteredAt": "2026-08-04T12:15:28Z",
      "runSummary": { "status": "matched", "text": "approximately 1 late" }
    }
  },
  "signals": {
    "signal-element-id": { "state": "blank" }
  }
}
```

`runSummary` (implemented Milestone 9) is `null` until the occupancy's berth-run resolution
exists. `status` is `matched`/`ambiguous`/`unmatched` (`GET
/api/v1/td/areas/{tdArea}/berths/{berth}/current-run` has the full detail); `text` is a short
Vail-like running-indication string built only from the matched run's latest real TRUST movement
report, `null` otherwise — never fabricated or predicted.

### `GET /api/v1/maps/{slug}/events?from=&to=&after=&limit=`

Compact map-relevant events for playback buffering. Cursor pagination; bounded range and result count.

### `GET /api/v1/berths/{tdArea}/{berth}/history?from=&to=&after=&limit=`

Occupancy intervals with resolution summary and playback link data.

### `GET /api/v1/descriptions/{description}/history?from=&to=&after=&limit=`

Occurrences across all retained TD areas.

### `GET /api/v1/runs/{runId}` (implemented Milestone 8; `resolverEvidence` implemented Milestone 9)

Run identity, activation, latest status, resolver evidence and links. `resolverEvidence` is the
most recent `berth_run_resolution` row that selected this run (a run occupies several berths
over its journey, each resolved independently — this is "why the resolver most recently linked a
berth to this run," not one fixed fact) — `null` when no occupancy has ever resolved to this run.
404 with `error.code: "RUN_NOT_FOUND"` for an unknown `runId`.

```json
{
  "runId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "trustTrainId": "2A1612AA26",
  "signallingId": "2A16",
  "serviceDate": "2026-08-10",
  "scheduleId": "42",
  "activatedAt": "2026-08-10T10:00:00.000Z",
  "originDepartureAt": "2026-08-10T10:01:00.000Z",
  "callType": "AUTOMATIC",
  "callMode": "NORMAL",
  "operatorCode": "NT",
  "serviceCode": "22222000",
  "lifecycleState": "activated",
  "supersededByTrainRunId": null,
  "lastEventAt": "2026-08-10T10:15:00.000Z",
  "scheduleLink": {
    "matchOutcome": "matched",
    "scheduleId": "42",
    "resolvedAt": "2026-08-10T10:00:00.000Z"
  },
  "resolverEvidence": {
    "status": "matched",
    "confidence": 0.79,
    "resolverVersion": 1,
    "decidedAt": "2026-08-10T10:15:05.000Z",
    "candidates": [
      {
        "trainRunId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "score": 75,
        "confidence": 0.79,
        "reasons": [
          "activation linked to a matched schedule",
          "occupancy time falls within the schedule's plausible window"
        ]
      }
    ]
  }
}
```

### `GET /api/v1/runs/{runId}/schedule` (implemented Milestone 8)

Ordered schedule locations for the run's linked schedule (same location shape as
`GET /api/v1/schedule/{trainUid}`'s `locations` array). 404 with `error.code: "RUN_NOT_FOUND"`
for an unknown `runId`; 404 with `error.code: "RUN_SCHEDULE_NOT_LINKED"` when the run exists
but has no matched schedule (activation resolver outcome was `ambiguous`/`unmatched`, or the
run has no activation at all — e.g. an Unidentified Train run).

### `GET /api/v1/status`

Sanitized status of web/API, nationwide feeds, archive durability, projections, schedules, storage pressure and playback.

### `GET /api/v1/td/areas`

List every observed TD area with first/last event times, C-Class/S-Class counts, heartbeat freshness and whether any published map uses it. This is backed by nationwide ingestion, not a configured allow-list.

### `GET /api/v1/td/areas/{area}/berths?observedFrom=&observedTo=&after=&limit=`

List observed berth identifiers and basic activity statistics for map-authoring and diagnostics.

### `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` (implemented Milestone 9)

The live map's click-a-berth popup, one round trip (`docs/PROJECT_SPEC.md` §5 "Train/run
popup"). 404 with `error.code: "BERTH_NOT_OCCUPIED"` when the berth has no current occupancy —
matches "click a **populated** berth." `resolution`/`run`/`schedule`/`latestMovement` are all
`null` until the resolver has processed the occupancy, or stay partially `null` per the match
outcome (`run`/`schedule`/`latestMovement` are only ever populated when `resolution.status ===
"matched"` — an `ambiguous` result surfaces its full `candidates` list instead of a chosen run,
never a silent pick).

```json
{
  "tdArea": "PX",
  "berth": "0512",
  "description": "2A16",
  "occupancyEnteredAt": "2026-08-10T10:14:58.000Z",
  "resolution": {
    "status": "matched",
    "confidence": 0.79,
    "resolverVersion": 1,
    "decidedAt": "2026-08-10T10:15:05.000Z",
    "candidates": [
      {
        "trainRunId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "score": 75,
        "confidence": 0.79,
        "reasons": ["..."]
      }
    ]
  },
  "run": {
    "runId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "trustTrainId": "2A1612AA26",
    "signallingId": "2A16",
    "serviceDate": "2026-08-10",
    "activatedAt": "2026-08-10T10:00:00.000Z",
    "operatorCode": "NT",
    "serviceCode": "22222000",
    "lifecycleState": "activated",
    "scheduleLink": { "matchOutcome": "matched", "scheduleId": "42" }
  },
  "schedule": {
    "scheduleId": "42",
    "trainUid": "U12345",
    "stpIndicator": "P",
    "source": "SCHEDULE",
    "originTiploc": "PRST",
    "destinationTiploc": "LANCSTR",
    "locations": [{ "seqNo": 1, "locationType": "origin", "tiploc": "PRST", "...": "..." }]
  },
  "latestMovement": {
    "eventType": "DEPARTURE",
    "locationStanox": "11224",
    "platform": "4",
    "variationStatus": "LATE",
    "timetableVariationMinutes": 3
  }
}
```

### `GET /api/v1/td/areas/{area}/s-class/events?from=&to=&after=&limit=`

Protected/diagnostic endpoint for retained S-Class source events. Lancaster may return data absence while other areas remain available. Apply strict range limits.

### `GET /api/v1/schedule/{trainUid}?date=YYYY-MM-DD` (added Milestone 7)

Resolves the STP-effective schedule for a `train_uid` on a given traffic day, via
`packages/domain`'s `resolveStpPrecedence` (`C` > `O` > `N` > `P`). `date` is required. Per
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
    "source": "SCHEDULE"
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

### `GET /api/v1/vstp/schedules?atocCode=&before=&limit=` (added Milestone 7)

Nationwide VSTP discovery/diagnostics, mirroring what `GET /api/v1/td/areas` gives TD: browse
everything captured (`schedule` rows with `source = 'VSTP'`) rather than needing an already-known
`train_uid`. Ordered most-recent-first; `before` (an opaque `id` cursor from the previous
response's `nextCursor`) pages backward in time — the reverse of the `after`-based cursors used
elsewhere in this API. `atocCode` filters to a single operator (NR's own CIF/VSTP field name for
what this API otherwise calls `operatorCode`, e.g. on the schedule endpoint above — same value).

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
  "enteredAt": "2026-08-04T12:15:38Z",
  "runSummary": null
}
```

`berth.updated`'s `runSummary` is always `null` (Milestone 9 scope decision — resolving it per
delta would mean an extra query on every changed row on the hot delta path). The snapshot sent on
connect/reconnect and the REST `/state` poll fallback both carry a real `runSummary` via
`computeLiveState`; deltas just don't refresh it in between. `run.resolution.updated` is declared
in the wire-format union for forward-compatibility but nothing emits it yet — that needs the
map-delta projector to also watch `berth_run_resolution`, not just `td_berth_event`.

Other messages:

- `berth.cleared`
- `run.resolution.updated` (declared, not yet emitted — see above)
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
