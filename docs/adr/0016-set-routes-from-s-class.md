# ADR 0016 — Set routes from S-Class route bits

- **Status:** accepted by the owner in chat, 2026-09-22 (approach and per-signal ownership chosen;
  visual reference supplied).
- **Date:** 2026-09-22
- **Milestone:** 64
- **Extends:** [ADR 0013](0013-s-class-decoding-and-signal-identification.md) decision 5, and
  reuses the state machinery of [ADR 0014](0014-level-crossing-barriers-from-s-class.md).
- **Amends:** `docs/PROJECT_SPEC.md` §10, which excluded routes.

## Context

The owner asked to show set routes "where it is possible", visually like Traksy, which draws a set
route as a green-and-black dashed line over the grey track from the entry signal to the exit signal,
through any crossovers. Traksy's own page shows how: every route is a pre-drawn polyline, hidden
until its route is set, painted in a layer above the track and below signals and berths.

Some TD areas publish route bits in S-Class. M9 (the Blackpool map) is one: the owner confirmed it
publishes signals and routes, and Milestone 56 identified `0C/4` as the route from S3879 and `0C/2`
as the route from S3870. ADR 0013 decision 5 deferred rendering routes to its own milestone and ADR,
and PROJECT_SPEC §10 listed routes as an MVP exclusion. This is that ADR.

## Decision

**1. A route is shown only from its own bound S-Class bit.** A `tdSBitRoute` binding names one
bit and states what a set bit means (`activeMeans: "set" | "unset"`), as signal and barrier
bindings do, and the author must state and verify it. Nothing else ever decides whether a route is
set: not the entry signal clearing, not berth steps, not the timetable, not an adjacent route.
Rule 10 applies to routes exactly as it does to signals. As ADR 0013 decision 4 allows for signals,
the S-Class explorer may _suggest_ a bit for a route at authoring time, for the owner to confirm
and bind. It never feeds runtime state.

**2. The state machinery is reused, the vocabulary is not.** Route state resolves through the same
`computeSignalStates` call as signals and crossings (one call per map, one set of facts, one `at`),
converted at the edges, as ADR 0014 did for barriers:

| route   | signal machinery |
| ------- | ---------------- |
| `set`   | `off`            |
| `unset` | `on`             |
| `blank` | `blank`          |

A route binding is its own binding type, not a widened `tdSBit`, so a route bit can never be
consumed as a signal aspect. The database checks `binding_type` and `active_means` together.

**3. Routes belong to their entry signal.** Every route starts at a signal, so a `route` element
carries a required `entrySignalId` and an optional `exitSignalId`. It may be omitted where a route
ends at a boundary or buffer stop. The editor authors routes from the signal's own panel, and a
map-wide list exists only to find routes with no bit bound or whose line no longer lies on the track.
A route is stored as its own element rather than nested inside the signal, because bindings, the
compiler, publish, live and playback all work per element id.

**4. The drawn line is stored; the tracks it follows are provenance (the "trace, then store"
approach).** The author traces a route in the editor by clicking along track from the entry signal.
The editor snaps to a graph of the existing track built from the drawing at authoring time. The
route's `points` polyline is authoritative for rendering, so the public renderer does no
path-finding. The `trackIds` it passed through are recorded so validation can warn
(`route_off_track`) when later track edits leave the route off the track, and the editor can
re-trace it. The authoring graph is derived from geometry only and is not written to `topology`.

**5. Display.** A set route paints over its track in a Traksy-style dash: a solid pale green line
with a dark dash on top, the same width as the track. `unset` and `blank` draw nothing on the public
map. The editor draws a route, in the same style, while it or its entry signal is selected, and
whenever its bound bit is live-set, so a wrong bit is obvious while authoring.
Routes paint above the rails and switched diamonds, and below signals and berths.

**6. No partial release.** Control-centre displays drop a route section by section behind the train.
The feed, as far as M9 shows, publishes one bit per route. Trimming the line behind a train using
berth steps would be inferring route state from train movements, so it is not done. A route is drawn
whole for exactly as long as its bit is set. If an area is found to publish sub-route or
track-circuit bits, optional per-section bindings can be added later as an additive field. This ADR
does not add them.

## Consequences

- Live, `/state?at=`, snapshots and playback show routes by construction: one resolution path shared
  with signals and crossings. Playback emits `route.updated` from the same paged stream, including
  the blank-on-silence rule. Historical route state is blank wherever the area's S-Class history is
  not decoded, as ADR 0014 records for barriers.
- `route.updated` carries absolute state. The wire's `routes` record is optional, so older clients
  and bundles keep working, and a missing record reads as "no routes set".
- Published map versions stay immutable. A bundle compiled before this ADR has no
  `routeBindingIndex`, and every reader treats that exactly like an empty one.
- Route state is not projected into its own table. It is derived from `td_s_event` like signal
  state, so there is nothing new to rebuild or retain.
- Migration `0042` widens `map_binding_index`'s checks for the new binding type. It must be applied
  before a map with a route binding is published.
- PROJECT_SPEC §10 now excludes only _inferred_ routes and automatic route setting (ARS) logic, not
  routes shown from their own bits.
- Milestone 38's structural track model is not a dependency. The authoring graph from decision 4
  is the natural seed for it: see the revised Milestone 38 direction in `IMPLEMENTATION_PLAN.md`.

## Measurement (2026-09-22): when an M9 route bit drops

Run with the Milestone 64d `route-candidates` query, read-only against production, over 14 days
of M9 for S3879 (`07:4`, a set bit means off; 1,004 clears):

- `0C:4` ranks first: 965 of its 1,006 changes to set are followed by S3879 clearing within 3
  minutes while it is still set. Median lead is 44 s, matching Milestone 56's hand-measured 46 s.
- It drops a **median 98 s after the signal clears**. The route is not held until the train
  reaches the exit signal; it is released while the train is passing through, the way train-
  operated route release works.

So the display decision 6 settled on (the route drawn whole while its bit is set) already disappears
about as the train takes the route, without inferring anything. Several bits in byte `06` also
score around 90%, since they too change with every train through the area, but they are held for
11-12 minutes after the clear, which sets them apart. The explorer shows both numbers for this
reason. The query takes about 2 s over the full 14 days.
