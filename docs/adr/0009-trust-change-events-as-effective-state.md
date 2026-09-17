# ADR 0009 — TRUST "change" events feed the resolver's effective state, not just a message log

## Status

Accepted and implemented 2026-09-17 (Milestone 49). Amends ADR 0006/0007/0008's `current-run`
resolver — no new tables; reads three tables ADR 0002's garner mirror already writes but the
resolver had never queried.

## Context

Owner report, 2026-09-17: on the owner's openrail (garner) instance, a TRUST Change of Origin,
Change of Identity, or Change of Location arrives and is stored (migration 0025:
`trust_changeorigin` / `trust_changeid` / `trust_changelocation`, plus `trust_cancellation`'s own
`loc_stanox` for a part-cancellation), but nothing downstream ever reads it back out except
openrail's own `/rail/livetrain` detail page — and even there, only into the message log at the
top of the page, never into the schedule table or the summary/departure/arrival boards. RLM's own
`current-run` popup has exactly the same gap: `effective.originTiploc`/`destinationTiploc` and
`effective.locations` come straight from `cif_schedules`/`cif_schedule_locations` — the _planned_
facts — never consulted against what TRUST has since said actually happened.

This is a real accuracy gap, not a cosmetic one: a train that's been retimed to start or end
part-way along its booked route, or swapped from one TRUST identity to another, was showing the
map's origin/destination and TRUST-id-keyed lookups (movements) exactly as if none of that had
happened — silently wrong, not merely incomplete, which is worse than showing nothing.

Two things needed deciding before implementing, both confirmed with the owner (2026-09-17):

1. **Sequencing.** This spans two codebases — openrail (`C:\Projects\openrail-master`, legacy C,
   no test suite, production CGI, no local compiler available in this environment) and RLM's own
   `current-run` resolver/API/web popup (this repo, fully typecheckable/testable). Owner chose to
   plan all three surfaces (RLM; openrail's detail page; openrail's summary/departure/arrival
   boards) and implement them together rather than sequencing one at a time.
2. **What "ending midway" means.** TRUST has no dedicated "change of destination" message. The
   owner confirmed the reading used throughout: a part-cancellation's own location (garner's
   `trust_cancellation.loc_stanox`, `reinstate = 0`) _is_ the run's new effective destination, as
   long as it hasn't since been reinstated (`reinstate = 1`) — mirroring how openrail's own
   `livetrain.c` already treats `reinstate` as "back to Activated."

This ADR covers the RLM side in full. The openrail (C) side is covered by the same milestone but,
being unable to compile-verify changes to that production CGI app in this environment, is
implemented more conservatively and flagged for the owner's own build/review before deploy — see
`docs/IMPLEMENTATION_PLAN.md` Milestone 49's "Known limitations."

## Decision

**`current-run`'s `effective` origin/destination/calling points/identity become derived,
current-state projections of the static schedule plus every mirrored TRUST change event for the
run — not the static schedule alone.** This is the same discipline CLAUDE.md rule 3 already
requires of berth occupancy/history, applied here to a schedule's own origin/destination/calling
points/identity.

- `packages/database/src/runResolution.ts` gains `fetchTrustChanges(pool, activationTrustId)`:
  - **Identity** is resolved first: walks `trust_changeid` forward one hop at a time (bounded to 8
    hops — the real hazard is a same-id cycle in production data, not a genuinely long chain),
    returning `effectiveTrustId` (what to key movement/allocation lookups on _now_) and the full
    `trustIdChain` the run has ever been known by.
  - **Origin/destination/location changes** are then read across the _entire_ chain (not just the
    latest id) and each reduced to its single latest event, since a change can arrive either side
    of a later identity change: `trust_changeorigin` → new origin; `trust_cancellation`
    (`reinstate = 0`, has a `loc_stanox`, and is the latest cancellation-family event for the
    chain) → new destination; `trust_changelocation` → a list of original→revised calling-point
    STANOX pairs.
  - STANOXes are resolved to TIPLOC/name via `location_reference`, folded into the same query
    `currentRun.ts` already runs to name every other TIPLOC in the response (no extra round trip).
- `apps/api/src/routes/currentRun.ts`: once an activation is found, calls `fetchTrustChanges`
  before anything else that's now change-aware. `effective.originTiploc`/`originName`/
  `destinationTiploc`/`destinationName` become the _current_ values (falling back to the static
  schedule's when nothing has changed); each `effective.locations[]` entry is replaced in place
  when a Change of Location names its original TIPLOC — no strikethrough, no "was" marker, simply
  the current value (owner request: unlike openrail's own detail page, see below). The
  `latestMovement`/`activationExtra` lookup now searches every TRUST id in `trustIdChain`, not just
  the activation's original id — a real, if secondary, bug fix: a movement reported under a
  _post-Change-of-Identity_ id was previously invisible to this endpoint entirely.
  `effective.activation.trustId` deliberately stays the original activation's own id (that's what
  the field has always meant — when/how this run was first identified); the current id is
  `effective.identityChange.newTrustId` when a Change of Identity has happened.
- New response fields, **full/authenticated response only** (same reasoning ADR 0006's owner
  addendum already applies to TRUST ids and the `deduced` flag — this reads as resolver-internal/
  diagnostic detail, not departure-board fact): `effective.originChange`/`destinationChange`
  (`{ previousTiploc, previousName, changedAt, reason } | null`) and `effective.identityChange`
  (`{ previousTrustId, newTrustId, changedAt } | null`). The anonymous/reduced response shape is
  otherwise unaffected — it already only ever carried `originTiploc`/`originName`/
  `destinationTiploc`/`destinationName`/`locations`, which are now simply current rather than
  static-only, with no new fields to withhold.
- `apps/web/src/map/RunPopup.tsx`: the full (logged-in) view shows each change's "was X, changed at
  HH:MM" detail alongside the current origin/destination/TRUST-id line; the reduced (anonymous)
  view is unchanged beyond now showing current values automatically, per the field's own new
  meaning.

**No strikethrough on the live map** (owner request, 2026-09-17, explicitly different from
openrail's own detail page): `effective.locations` never marks a revised calling point specially,
it's simply replaced. The live map is a current-state view; the "what it used to say" detail lives
only in `originChange`/`destinationChange`/`identityChange` for someone who wants it, not as a
struck-through artifact in the main calling-point list.

## Consequences

- No migration — every table this reads (`trust_changeorigin`/`trust_changeid`/
  `trust_changelocation`/`trust_cancellation`) already exists (migration 0025) and was already
  being synced by `apps/worker/src/garner/bridge.ts`; this is the first code that reads them back
  out for anything beyond openrail's own message log.
- Real bug fix, not just a new feature: `latestMovement` previously went stale/blank for any run
  that had a Change of Identity, since movements reported under the new id were invisible to a
  query still filtered to the original activation's `trust_id` alone.
- `EffectiveScheduleFull`'s public API shape gains three fields (`originChange`, `destinationChange`,
  `identityChange`) — additive, full-response-only, no existing field's meaning changed except that
  `originTiploc`/`destinationTiploc`/`locations[].tiploc`/`locations[].locationName` now mean
  "current" rather than "as originally scheduled" (a strictly more correct reading of what those
  field names already implied).
- Openrail's own three surfaces (detail-page strikethrough, summary/departure/arrival boards) are
  covered by the same milestone but implemented separately in that repo, without the ability to
  compile-check them in this environment — see Milestone 49's own "Known limitations" for what that
  means for review/deploy.
- Still bounded, not exhaustive: the identity-chain walk stops at 8 hops (a real chain this long
  has never been observed; this is a safety bound against a cyclic mirror-data hazard, not a
  believed real limit), and a Change of Location is matched to a calling point by TIPLOC-derived-
  from-STANOX, which (like every other STANOX→TIPLOC lookup already in this codebase, e.g.
  `movementLocationName`) can be ambiguous when a STANOX legitimately maps to more than one TIPLOC
  (platform-level TIPLOCs sharing one station STANOX) — an existing, accepted imprecision in this
  codebase, not one this change introduces.
