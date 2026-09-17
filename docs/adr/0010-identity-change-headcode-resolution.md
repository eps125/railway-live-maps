# ADR 0010 — a TRUST Change of Identity can change a run's own headcode, and the resolver must follow it

## Status

Accepted and implemented 2026-09-17 (Milestone 49 addendum). Amends ADR 0006/0007/0008/0009's
`current-run` resolver. No migration.

## Context

Owner correction, 2026-09-17, against ADR 0009's first pass: `livetrain.c`'s message log should
never strike through the "Change ID" row (that treatment was wrong — reverted), and a real example
from the owner's own `openrail` instance revealed something ADR 0009 had missed entirely —

> `16/09/26 23:04:12  Change ID  Old ID: 426C02C417  New ID: 420C02C417`
>
> "that 426C02C417 to 420C02C417 means that the signalling id should change from 6C02 to 0C02."

TRUST's own 10-character train identity string is not an opaque token — it encodes the run's
4-character reporting headcode within it: 2-digit start hour + **4-character headcode** +
2-character TOC + 2-digit day of month (the day-of-month component is already relied on elsewhere
in this codebase: `apps/api/src/routes/currentRun.ts` and openrail's own `livetrain.c`/
`liverail.c` all use `substring(trust_id FROM 9)`). A Change of Identity can therefore change the
headcode a run actually reports as, not merely swap one opaque id for another.

**This is not just a display gap — it's a resolver correctness bug the owner had already hit for
real**: "For the livemap before these edits it did not resolve correctly because the train ran on
the map as 0C02 but the schedule was still 6C02 so they never matched. Instead it matched to a
totally different 0C02 elsewhere." garner's `cif_schedules.signalling_id` is the _originally
booked_ headcode and never retroactively updates when TRUST later changes it. Once a Change of
Identity happens, the TD berth itself starts showing the run's new headcode (a signaller sees and
enters the new reporting number), while the booked schedule for that same run stays keyed by the
old one in `cif_schedules`. `queryCandidateSchedules` (ADR 0006) searches by the TD berth's
_current_ headcode — so it can no longer find the correct, still-valid schedule at all, and worse,
can find a **different, unrelated real train** that genuinely carries the new headcode elsewhere on
the network, silently matching to it with full confidence. This is exactly the failure mode
CLAUDE.md rule 5 ("never assume a four-character berth description uniquely identifies a train
run") exists to prevent, and it had already happened in production.

## Decision

**Search the other direction too, and merge what it finds into the ordinary candidate pool rather
than special-casing or silently preferring it.**

- `packages/domain/src/trust/trustId.ts`: `headcodeFromTrustId(trustId)` — the pure decode
  (`trustId.slice(2, 6)`, `null` unless exactly 10 characters). Exported from `@railway/domain` for
  display callers; the resolver's own matching logic below does the equivalent directly in SQL
  rather than round-tripping through this.
- `packages/database/src/runResolution.ts`: `findSchedulesByIdentityHeadcodeChange(pool, headcode,
sinceDate, tiplocs)` — finds every schedule reachable by joining `trust_changeid` (whose
  `new_trust_id` decodes to this exact headcode) back to that _old_ trust_id's own
  `trust_activation`, recovering the `cif_schedule_id` it was actually activated against.
  Position-scoped the same way `queryCandidateSchedules` is, when this berth has SMART coverage.
- `resolveFreshRunMatch` calls this alongside the ordinary `queryCandidateSchedules`, and merges
  whatever it returns into the candidate pool (deduplicated by schedule id) _before_ activation
  lookup, STP precedence, or any tier runs. From that point on it is just another candidate,
  competing fairly through every existing rule — critically, **two genuinely competing activated
  candidates (the correct renamed run, and a real coincidental same-new-headcode train elsewhere)
  still report `ambiguous`, never a silent pick** (CLAUDE.md rule 7). This is a deliberately
  conservative design: it doesn't invent a new precedence tier that outranks a plain
  `trust_activation` match, since that would need the same kind of real-incident-driven precedence
  tuning ADR 0008's addenda went through, which this fix hasn't had the chance to. In practice this
  converts a previously _silent wrong match_ into either a _correct match_ (the overwhelmingly
  common case — a genuine same-new-headcode collision, activated at the same moment, is rare) or an
  _honest ambiguity_ — both strictly safer than what shipped before this fix.
- `fetchTrustChanges` (ADR 0009) gains `previousHeadcode`/`newHeadcode` (decoded via
  `headcodeFromTrustId`) on top of `previousTrustId`/`effectiveTrustId`, threaded through
  `currentRun.ts`'s `identityChange` and shown in `RunPopup.tsx` alongside the TRUST id change.
- **openrail (`C:\Projects\openrail-master`) corrections to ADR 0009's first pass:**
  - `livetrain.c`'s message log "Change ID" row reverted to plain text — no strikethrough there
    (owner correction). The struck-through-old/new-headcode treatment moves to the page's own
    `<h2>` title instead, decoded from the TRUST identity chain the same way as above.
  - `liverail.c`'s `report_train_summary` (SUMMARY/DEPART/PANEL boards) now also overrides the
    displayed headcode column itself (previously deliberately left alone — ADR 0009 noted "no
    verified logic... for deriving a display headcode from a TRUST id"; this ADR _is_ that
    verification, confirmed directly against the owner's own real example).

## Consequences

- Closes a real, already-observed false-match: a run whose headcode changed via TRUST no longer
  either goes unmatched or silently matches an unrelated train sharing its new headcode.
- `TrustChangeSummary` and `EffectiveIdentityChange` (RLM's public API shape) gain
  `previousHeadcode`/`newHeadcode` — additive, full-response-only, same visibility rule as the rest
  of `identityChange`.
- Deliberately does not attempt to outrank an ordinary `trust_activation` match with the
  identity-change-derived one when both are genuinely activated — see the conservative-design note
  above. If a real incident ever shows this ambiguity firing in practice (as opposed to the
  previous silent-wrong-match failure mode), that's the trigger for a follow-up addendum with a
  dedicated precedence rule, mirroring how ADR 0008 was built out incrementally against real cases
  rather than speculatively up front.
- The openrail (C) side remains unverified beyond a clean CI compile (see Milestone 49's own "Known
  limitations") — this ADR's corrections were made the same way as the rest of that milestone, by
  close reading against the owner's own real example, not by running the code.
