# ADR 0001 — Nationwide capture is independent of map coverage

## Status

Accepted.

## Context

Lancaster is the first signalling map to be authored, and it belongs to the Preston train-describer area. That initial map choice must not be mistaken for an ingestion boundary. The owner wants the platform to retain the complete subscribed Network Rail dataset so future maps and historical queries can use data recorded before those maps existed.

Preston/Lancaster does not have usable S-Class data, but other TD areas may. Discarding other-area events would permanently remove future playback, berth-history and signal-binding evidence.

## Decision

The platform will:

- ingest every child event from the nationwide TD feed, across every area
- retain C-Class, S-Class and unknown/not-yet-supported TD message types
- retain all subscribed nationwide TRUST and VSTP events
- archive complete original broker frames and downloaded source files
- import complete available schedule and reference datasets
- build map-independent nationwide berth history/current-state projections
- use map bindings only when selecting data for rendering, WebSocket delivery and map playback

There will be no `ACTIVE_TD_AREAS`, Preston-only filter or map-based retention allow-list.

The Preston TD `area_id` must still be verified from captured data, but only so Lancaster berth bindings use the correct composite identifier.

## Consequences

- Storage and throughput requirements are materially higher than a Lancaster-only recorder.
- PostgreSQL partitioning, object archival, growth metrics and backup/restore testing are required early.
- Areas can be mapped later with history already available from the date nationwide capture began.
- S-Class data can be researched and bound for future maps even though Lancaster signals remain blank.
- Public map APIs may remain map-specific while private/history APIs query nationwide data.
