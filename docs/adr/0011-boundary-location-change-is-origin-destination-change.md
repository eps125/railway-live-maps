# ADR 0011 — a Change of Location revising the first/last calling point is an origin/destination change too

## Status

Accepted and implemented 2026-09-17 (Milestone 49 second addendum). Amends ADR 0009/0010's
`current-run` resolver. No migration.

## Context

Owner report against a real train (`W32435`, openrail's own `/rail/livetrain/W32435/17/09/26`),
2026-09-17: its last calling point, `NY DBS`, was changed via a TRUST Change of Location to
`Carlisle Kingmoor Sidings (DRS)` — and since that's the schedule's own final (LT) location, it
_is_ the train's new destination, not merely a revised mid-journey stop. ADR 0009 already read a
Change of Location into `effective.locations[]` (the calling-point list) but never checked whether
the point being revised was the origin or destination itself, so neither
`effective.originTiploc`/`destinationTiploc` nor the equivalent openrail heading/board text picked
it up. The owner also confirmed, on being asked, that a Change of Location revising the _origin_
point should be treated symmetrically.

This sits alongside the two existing origin/destination mechanisms from ADR 0009
(`trust_changeorigin` for origin; a part-cancellation for destination, TRUST having no dedicated
"change of destination" message) as a third, independent way the same fact can change — and,
unlike those two, a Change of Location has no built-in notion of "this affects the origin or
destination specifically"; that has to be inferred by comparing the location it revises against the
schedule's own already-known first/last calling point.

## Decision

**A Change of Location whose own original point matches the schedule's booked origin or
destination TIPLOC is read as an origin/destination change, on top of the existing
`trust_changeorigin`/part-cancellation mechanisms — whichever actually happened _later_ wins when
more than one applies**, since both are genuine, independent ways the fact can change and either
can legitimately follow the other.

- `packages/database/src/runResolution.ts`: `fetchTrustChanges` gains two new parameters,
  `originTiploc`/`destinationTiploc` (the caller's already-known static LO/LT) — matched against
  each `trust_changelocation` row's own resolved `originalTiploc`, `.at(-1)` (locations are
  read oldest-first) picking the latest match for each boundary. A small `latestOf` helper picks
  between the `trust_changeorigin`/cancellation-derived candidate and the changelocation-derived
  one by `changedAt`, for both origin and destination symmetrically. `currentRun.ts` passes
  `effectiveRow.origin_tiploc`/`destination_tiploc` through at the one call site.
- **openrail (`C:\Projects\openrail-master`):**
  - `livetrain.c`'s `<h2>` title's "Origin to Destination" text (previously untouched by any of
    this) now applies the same three-way merge, checked against the schedule's own captured
    `origin_tiploc_static`/`destination_tiploc_static`. Its "Signalling ID" row (the table to the
    left of the schedule/message log, a `train-table` field distinct from the `<h2>` title) now
    also shows the struck-through-old/new-headcode treatment ADR 0010 built for the title —
    previously only the title had it.
  - `liverail.c`'s `report_train_summary` origin/destination override (ADR 0009/0010) gains the
    same changelocation-boundary check, matched against whichever of LT/LO this particular board
    row is actually displaying (`calls[index].terminates` picks between them, same as the existing
    "To"/"From" logic).
  - Both C-side additions are deliberately **not** timestamp-compared against the
    `trust_changeorigin`/cancellation candidate the way the TypeScript side is — the changelocation
    check simply runs last and wins when it matches, a documented simplification consistent with
    this milestone's existing "keep the uncompiled C surface small and reviewable" scope-limit
    (ADR 0010's own note on `liverail.c` checking only the direct `trust_id`, not the full identity
    chain, is the same kind of trade-off).

## Consequences

- Closes the real gap: `W32435`'s revised destination (`Carlisle Kingmoor Sidings (DRS)`) now shows
  correctly wherever origin/destination is shown, on both RLM's live map and openrail's own pages.
- `fetchTrustChanges`'s signature changes (two new required parameters) — its one caller
  (`currentRun.ts`) updated in the same change; no other caller exists yet.
- `TrustChangeSummary.originStanox`/`destinationStanox` now reflect whichever source (dedicated
  message vs. boundary-matching Change of Location) actually won, not `trust_changeorigin`/
  `trust_cancellation` unconditionally — no consumer currently reads these two fields directly
  (only `*Tiploc`/`*ChangedAt`/`*ChangeReason` are), so this is not an observed behaviour change for
  any existing caller.
- The C-side "changelocation always wins when present, not timestamp-compared" simplification means
  a same-boundary `trust_changeorigin`/cancellation event that happens to arrive _after_ a
  changelocation event would still show the changelocation's value on openrail's pages, unlike the
  TypeScript side. Deliberately accepted for this pass — see the Decision section above; worth
  revisiting only if a real case shows this mattering, mirroring how ADR 0008's precedence rules
  were themselves built out incrementally against real incidents rather than speculatively.
- Unverified on the openrail (C) side beyond a clean compile, same as every other C change in this
  milestone (see `docs/IMPLEMENTATION_PLAN.md` Milestone 49's own "Known limitations").
