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
      "runSummary": null
    }
  },
  "signals": {
    "signal-element-id": { "state": "blank" }
  }
}
```

### `GET /api/v1/maps/{slug}/events?from=&to=&after=&limit=`

Compact map-relevant events for playback buffering. Cursor pagination; bounded range and result count.

### `GET /api/v1/berths/{tdArea}/{berth}/history?from=&to=&after=&limit=`

Occupancy intervals with resolution summary and playback link data.

### `GET /api/v1/descriptions/{description}/history?from=&to=&after=&limit=`

Occurrences across all retained TD areas.

### `GET /api/v1/runs/{runId}`

Run identity, activation, latest status, resolver evidence and links.

### `GET /api/v1/runs/{runId}/schedule`

Ordered schedule locations.

### `GET /api/v1/status`

Sanitized status of web/API, nationwide feeds, archive durability, projections, schedules, storage pressure and playback.

### `GET /api/v1/td/areas`

List every observed TD area with first/last event times, C-Class/S-Class counts, heartbeat freshness and whether any published map uses it. This is backed by nationwide ingestion, not a configured allow-list.

### `GET /api/v1/td/areas/{area}/berths?observedFrom=&observedTo=&after=&limit=`

List observed berth identifiers and basic activity statistics for map-authoring and diagnostics.

### `GET /api/v1/td/areas/{area}/s-class/events?from=&to=&after=&limit=`

Protected/diagnostic endpoint for retained S-Class source events. Lancaster may return data absence while other areas remain available. Apply strict range limits.

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

Other messages:

- `berth.cleared`
- `run.resolution.updated`
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
