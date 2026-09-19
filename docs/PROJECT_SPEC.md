# Product Specification

## 1. Product statement

Railway Live Maps is a self-hosted nationwide Network Rail open-data recorder and web application showing low-level train-describer berth activity on manually authored schematic railway maps. It captures all subscribed TD areas, TRUST events, VSTP events and complete timetable/reference datasets, retains the source data needed to reconstruct history, and supports playback to a selected time.

The initial authored/public map is Lancaster. It is part of the Preston signalling/train-describer area, but only map-relevant berths are displayed. The full Preston area does not need to be drawn before Lancaster is useful, and the absence of maps for other TD areas must not prevent their data being captured, projected or queried.

## 2. Inspiration and boundaries

Desired interactions are inspired by:

- Vail Data live maps, train popup and berth history.
- Traksy live maps.
- OpenTrainTimes signalling maps.

Do not copy their source code, proprietary map geometry, branding or assets. Build an original implementation using licensed Network Rail data and map geometry created or lawfully sourced by the owner.

## 3. Safety and representation

Every public map and history page must state:

> For information and enthusiast use only. Not official and not suitable for safety-critical or operational decisions.

The interface must distinguish observed facts from inferred associations.

## 4. Nationwide capture boundary

From the first live ingestion milestone, the backend must:

- Subscribe to the nationwide TD topic and retain every child event from every TD area, including C-Class, S-Class and unknown/not-yet-supported types.
- Subscribe to the nationwide TRUST and VSTP topics and retain every event, not only trains relevant to Lancaster.
- Import the complete available schedule and reference datasets rather than a Lancaster-only subset.
- Build map-independent current/history projections for all C-Class berth data.
- Store S-Class source data from every area even though Lancaster cannot display operational signal state.
- Keep ingestion independent of which maps are drafted, published or active.

Map-specific APIs and WebSockets may filter nationwide projections to the bindings in a published map, but that filtering occurs after durable ingestion.

## 5. MVP user stories

### Live map

A visitor can:

- Open the Lancaster map without signing in.
- See the current four-character description in every configured berth.
- See a clear connected/stale/data-gap status.
- Click a populated berth to open a train/run popup.
- Pan and zoom without losing crisp text.
- Return to live after viewing history.

### Train/run popup

When a berth description can be associated with a train run, show:

- Map berth name and raw TD berth identifier.
- Four-character description/headcode.
- Scheduled origin and destination.
- Booked origin departure and relevant calling/pass times.
- Operator/business code and resolved display name where available.
- TRUST activation timestamp.
- TRUST train ID/TID.
- Schedule UID.
- Schedule type/source: permanent, overlay, STP, VSTP or cancellation where applicable.
- Latest TRUST report, location, event type and timetable variation.
- Match status and confidence/evidence.
- Links to full schedule, run history and berth history.

If no schedule is found, show the raw description and `No matching activated schedule found`; do not fabricate a service.

If several runs are plausible, show `Ambiguous` and the candidates rather than choosing silently.

### Running indication

A Vail-like summary such as `approximately 1 early` may be displayed only when it is clearly derived from the latest TRUST report. The detailed view must show the report location and age. TRUST is not a prediction feed, so do not imply continuous exact location or punctuality between reports.

### Berth history

A visitor can query:

- TD area plus berth plus date/time range.
- A description/headcode plus date/time range.
- A resolved train run.

Each row includes entered time, left time, duration, description, source event types, resolved run if any, and a link that opens playback shortly before entry.

### Playback

A visitor can:

- Choose a date and local time.
- Jump directly to that time.
- Pause and resume.
- Step backward/forward by 10 seconds, 1 minute and 10 minutes.
- Select speeds including 0.25x, 0.5x, 1x, 2x, 5x and 10x.
- See a persistent `Historical playback` indicator.
- Return to live.
- See warnings where the recorder had an outage or an unrecoverable feed gap.

### Visual map editor

An authorized owner can:

- Create and edit a map graphically.
- Draw schematic track paths on a grid.
- Add berths, blank signal symbols, platforms, labels, boundaries and continuation links.
- Bind berths to any observed TD area and berth code in the nationwide database.
- Use snap, alignment, duplication, grouping, layers, undo and redo.
- Test with simulated, current live or historical states.
- Validate a draft.
- Publish an immutable version with an effective date.
- Compare a draft with the currently published version.

## 6. Lancaster signal behavior

Lancaster has no usable S-Class data in scope. Signal symbols are allowed as static map context but their operational indication is blank.

Future maps may bind S-Class indications. The only public signal states are:

| Internal state | Public rendering | Meaning                                             |
| -------------- | ---------------- | --------------------------------------------------- |
| `unmapped`     | blank            | no mapping configured                               |
| `unknown`      | blank            | mapping exists but no valid/fresh value             |
| `on`           | red              | signal indicated on                                 |
| `off`          | green            | signal indicated off; actual proceed aspect unknown |

No aspect sequence or actual yellow/double-yellow/green calculation is permitted.

## 7. C-Class berth semantics

The system must implement the source semantics directly:

- `CA` berth step: clear the `from` berth and overwrite/open the `to` berth with `descr`.
- `CB` berth cancel: clear the `from` berth.
- `CC` berth interpose: overwrite/open the `to` berth with `descr`.
- `CT` heartbeat: update feed/area health only; do not alter berth occupancy.

Every overwrite closes the previous occupancy interval at the event time and records the reason. State mismatches, impossible transitions, duplicate deliveries and out-of-order arrivals are anomalies to log, not reasons to drop the source event.

Descriptions are arbitrary four-character operational strings, not always valid public headcodes.

## 8. Data quality behavior

The UI must never pretend data is complete when it is not.

Track and expose:

- Broker connection state.
- Last received frame.
- Last nationwide TD frame and child event.
- Last C-Class and S-Class event by TD area.
- Last TD heartbeat by area, when present.
- Ingestion lag.
- Projection lag.
- Known feed gaps.
- Schedule import age.
- TRUST feed age.

When state becomes stale beyond configurable thresholds, show a banner. Do not automatically colour a blank signal or retain an old signal indication indefinitely.

## 9. Retention

Retention must be configuration-driven. Initial defaults:

- All-area TD normalized events and all berth occupancy intervals: indefinite by default.
- All nationwide TRUST and VSTP normalized events: indefinite by default.
- Complete raw broker frames and downloaded source files: compressed immutable archive, indefinite by default.
- PostgreSQL hot copies of raw payloads may have a configurable retention window only after the immutable archive has been verified and restore/reprocessing has been tested.
- Map snapshots: at least 90 days; older state remains reconstructable from retained nationwide events.
- Published map versions: indefinite.
- Draft revision history: at least 90 days.

No automated deletion job is enabled until a retention policy and backup have been tested.

## 10. Explicit MVP exclusions

- Actual signal aspects.
- Inferred signals, points, routes or track circuits.
- Automatic route setting visualization.
- Train position interpolation between berths.
- Nationwide public map coverage in the first release. Nationwide data capture is included.
- Native mobile applications.
- Multi-user collaborative editing.
- Scraping third-party rail sites.
- Safety-critical use.

## 11. Success criteria

The MVP is successful when:

1. Every subscribed TD/TRUST/VSTP event is durably retained regardless of area or current map coverage.
2. Lancaster berth changes appear live and survive process restarts.
3. Every C-Class event from every TD area is queryable with source lineage.
4. Nationwide berth occupancy history is correct for CA, CB and CC sequences.
5. A berth description can be resolved to its TRUST activation/schedule where evidence allows.
6. Playback reconstructs the same canonical state for a given map version and timestamp.
7. The owner can produce and publish the Lancaster map without editing frontend source code.
8. Feed outages, storage pressure and ambiguity are visible rather than hidden.
