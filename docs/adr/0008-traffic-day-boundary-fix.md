# ADR 0008 — Traffic-day boundary fix for the berth-run resolver

## Status

Accepted and implemented 2026-09-15 (post-Milestone 39 bugfix, no new milestone). Amends ADR 0006
and ADR 0007's resolver — no data model change, no new tables.

## Context

`GET .../current-run` (ADR 0006, Milestone 34/35) and the proactive sweep/step-chain upgrade paths
built on it (ADR 0007, Milestone 39) all compute a single `today` — `londonToday(new Date())`, the
Europe/London _calendar_ date — and use it everywhere: as the SQL date-range filter for candidate
`cif_schedules`, as the day-of-week bitmask check in `resolveRunMatch`'s pure logic, as the TRUST
activation cutoff, and as the `traffic_day` recorded on a `berth_occupancy_run_link`. `londonToday`'s
own doc comment already flagged the simplification ("does not need WTT 02:00 boundary precision")
without anyone noticing it could make a real, currently-running train literally unmatchable.

**Real incident, 2026-09-14**: PX berth 0052 showed headcode `5F05` (train UID `W33229`, Preston →
Edge Hill Depot, departed 23:28 the previous night) as `unmatched` — "no candidate schedule found"
— seconds after the London calendar rolled to the next day, even though the train was still
genuinely running (confirmed near Crewe via the reference site) and its schedule (dated only the
previous day) still existed in the garner mirror with every calling point synced. Confirmed by
direct SQL, not guessed: querying with the previous date found the schedule; querying with the date
the app actually computed did not.

Widening the SQL candidate query's date filter alone is not sufficient by itself.
`resolveRunMatch`'s pure logic (`candidatesRunningOn`/`runsOnDate`,
`packages/domain/src/schedule/resolveStpPrecedence.ts`) independently re-filters every candidate
against one shared `serviceDate` string — checking **both** the date range **and** the
day-of-week bitmask against that one date. A yesterday-dated candidate pulled in by a widened SQL
query would be filtered straight back out by this pure function unless it's made aware of which
day (today or yesterday) each candidate actually belongs to. The TRUST activation cutoff and the
traffic day recorded downstream (`train_allocation` lookups, `train_run.traffic_day`) have exactly
the same problem, one level up.

Owner-confirmed approach (2026-09-13/14 discussion): check both today's and yesterday's date, not
a full Working Timetable (WTT) 02:00-boundary rewrite — WTT-accurate traffic-day modelling (the
railway's own definition of a "day" runs roughly 02:00-to-02:00, not midnight-to-midnight) is a
materially bigger undertaking than this bug needs; a two-date probe window closes the real gap
(a schedule crossing exactly one midnight) without that scope.

## Decision

**Give each schedule candidate its own resolved traffic day, rather than testing every candidate
against one shared date.**

- `packages/domain/src/schedule/resolveStpPrecedence.ts` gains `candidatesRunningOnAny` and
  `selectEffectiveScheduleAcrossDates` — additive, alongside the existing single-date
  `candidatesRunningOn`/`selectEffectiveSchedule` (unchanged, still used by
  `apps/api/src/routes/schedule.ts`'s unrelated single-date effective-schedule lookup). Both new
  functions take `serviceDates: readonly string[]` (ordered most-preferred first — callers pass
  `[today, yesterday]`) and tag each running candidate with the _first_ date in that order it
  actually runs on.
- `resolveRunMatch` (`packages/domain/src/schedule/resolveRunMatch.ts`) takes `serviceDates`
  instead of a single `serviceDate`, and a `matched`/`ambiguous` result now carries the resolved
  `trafficDay` alongside the selected/tied candidate(s) — the caller must use this, not a
  hardcoded `today`, for anything keyed by the match's traffic day.
- `packages/database/src/runResolution.ts`:
  - New `previousCalendarDate(dateStr)` — pure calendar-string arithmetic (parses as UTC midnight,
    steps back a day, reformats), deliberately never touching a real zoned instant so it can't be
    thrown off by the BST/GMT transition.
  - `queryCandidateSchedules` takes `serviceDates` and widens its SQL filter to `schedule_start_date
<= max(serviceDates) and schedule_end_date >= min(serviceDates)` — a deliberate superset; the
    precise per-date day-of-week check still happens purely, afterward, in `resolveRunMatch`.
  - `resolveFreshRunMatch` computes `yesterday = previousCalendarDate(today)`, probes
    `[today, yesterday]` throughout, widens the TRUST activation cutoff to `created >= yesterday's
London midnight`, and returns the resolved `trafficDay` (`null` iff unmatched) alongside
    `effectiveRow`.
- `apps/api/src/routes/currentRun.ts` and `apps/worker/src/runLineage/projector.ts`
  (`sweepFreshResolution`, `attemptStepChainUpgrades`) all now use the resolver's own
  `trafficDay`/`effectiveTrafficDay` — never a hardcoded `today` — for: the TRUST activation
  full-detail query, the `train_allocation` unit-allocation lookup, and the `trafficDay` written to
  `berth_occupancy_run_link`/`train_run`. The Milestone 39 lineage-shortcut path
  (`currentRun.ts`'s `lineageSchedule` branch) already had the correct traffic day available —
  `occupancyLink.trafficDay`, from `train_run.traffic_day` — but was using hardcoded `today`
  instead; fixed alongside the fresh-resolution path since it's the same class of bug.

**Ordering (`[today, yesterday]`) matters**: a candidate satisfying both probed dates (the
overwhelming common case — a permanent, daily-running schedule) resolves to _today_, preserving
existing behaviour for every non-overnight match. Only a candidate that runs on yesterday but not
today (the overnight case this fixes) resolves to yesterday.

**Two independently-activated candidates across the two dates is `ambiguous`, not a silent pick**
(CLAUDE.md rule 7) — e.g. a still-running overnight schedule and a fresh, same-headcode service
starting today, if both happen to already have a same-day TRUST activation. This is a real,
correct ambiguity to surface, not a regression the widening introduced.

## Consequences

- Closes the real gap: an overnight train's schedule stays matchable across the London midnight
  boundary it was always going to cross, without a full WTT 02:00-boundary rewrite.
- `RunMatchResult`'s `matched`/`ambiguous` shape gained a `trafficDay` field on the matched variant
  — a type-level change to `@railway/domain`'s public API, but with only two real callers
  (`packages/database/src/runResolution.ts`, tests), both updated in the same change.
- Still not WTT-accurate (a schedule crossing _two_ midnights, or a real 02:00 traffic-day
  boundary rather than a calendar one, is out of scope) — deliberately, per the owner's own
  scoping call above. If a future incident needs that precision, it's a separate ADR, not an
  extension of this two-date probe.
- No migration: `train_run.traffic_day` already stored a `date` column (migration 0032); this
  changes which date gets written into it, not the column itself.

## Addendum (2026-09-15): TRUST activation must be checked per resolved date, not per schedule id

Found the same day this ADR shipped, investigating a real report: PX berth 0107, headcode `1Y61`,
reported `unmatched`/`ambiguous` by the owner despite an obviously correct, confidently-activated
candidate (`G89843`, confirmed against the reference site). Two schedules — `G89843` (calls PRST
~10:52) and `G89845` (calls PRST ~20:50) — share this headcode and both call at the same
position-scoped berth **every day** (`days_runs_bitmask` all-1s). Confirmed by direct SQL: `G89843`
had a genuine activation from that same morning (08:25); `G89845`'s most recent activation was from
**the evening before** (18:22 the prior day), for its own prior day's working — its today's-due
20:50 service hadn't been activated yet.

**Root cause**: widening the TRUST activation SQL query's cutoff to `yesterday`'s midnight (this
ADR's own fix, above — needed so an overnight train's pre-midnight activation still counts) was
paired with a flat `activatedScheduleIds: Set<scheduleId>` membership check in `resolveRunMatch` —
"was there _any_ activation row for this schedule id within the widened window," with no awareness
of which calendar day each row actually belonged to. For a daily-repeating schedule sharing a
headcode with another daily-repeating schedule at the same station, this reintroduced exactly the
kind of false collision the two-date probe was designed to avoid: `G89845`'s stale, entirely
unrelated prior-day activation started counting as "activated" for _today's_ tier check too,
alongside `G89843`'s real same-morning one — `activated.length === 2` → wrongly `ambiguous`.

**Fix**: `resolveRunMatch` now takes `activatedDatesByScheduleId: ReadonlyMap<string,
ReadonlySet<string>>` — schedule id → the specific calendar dates (the activation row's own
`created`, resolved to its London calendar date) it actually has an activation on — and checks each
`DatedCandidate` (`candidatesRunningOnAny`'s own scheduleId+resolvedServiceDate pairing) against
that specific date, not schedule-id membership alone. `packages/database/src/runResolution.ts`
builds this from the same already-widened activation query (no new SQL, no new round trip) by
grouping each row under `londonToday(row.created)` instead of collapsing to one row per schedule.
This fixes both cases correctly with the same structure: an overnight train's activation is dated
on the same day its resolved `serviceDate` correctly comes out to (yesterday), so it still counts;
a same-headcode sibling's stale prior-day activation no longer collides with a _different_
schedule's today occurrence. `buildCandidateSchedules`'s `activatedToday` display field (shown to
authenticated users in the candidate list) is similarly re-scoped to a `todaysActivationByScheduleId`
map containing only rows dated specifically `today` — it was inheriting the same "activated
anywhere in the widened window" imprecision for display purposes, which this also corrects.

No SQL/schema change — same widened query as the original fix, just grouped by the row's own date
instead of collapsed to "most recent regardless of date." Tests: `resolveRunMatch.test.ts` (+1 case
reproducing this exact PX 0107/1Y61 scenario), `currentRun.integration.test.ts` (+1 integration
case: two daily-running, position-scoped, same-headcode schedules, one activated today, one
activated only the day before — must resolve `matched`/`trust_activation` to today's, not
`ambiguous`).

Also confirmed the same day against a second real report (PX 0126, headcode `5S65`, correct
schedule `P65371`) via a direct repro against production data (running the built resolver code
inside the live `run-lineage` container against the real database) — same root cause, same fix.

## Second addendum (2026-09-15): an unscoped match with only one running candidate is solid

Owner observation, prompted by the `5Z07`/`9S47` reports above (both correctly resolved
internally — confirmed via the reference site — but hidden from the public map because their
current berth has no SMART coverage): "if there's only one candidate then surely that's a good
match?"

Re-examining why `headcode_only` (docs/adr/0006) is treated as the weakest tier: the real risk it
guards against is a **different, unrelated train sharing the same headcode elsewhere on the
network** — a genuine, common occurrence (confirmed earlier the same day: headcode `1M73` had two
completely different real trains, `G66797` and `W84884`, both running nationwide on 2026-09-15).
When the unscoped nationwide search for a headcode finds **exactly one** running candidate for the
day, that specific risk is provably zero — not merely assumed absent — regardless of whether the
berth itself has position data to independently verify against.

**Decision** (owner-confirmed): `resolveFreshRunMatch`'s `isSolidMatch` — which gates public/
anonymous visibility (docs/adr/0006's owner-request addendum) — now also treats an unscoped match
as solid when the unscoped search returned only one running candidate. Two or more running
candidates (even when the resolver itself cleanly picks a winner via STP precedence or TRUST
activation) still keeps the existing weak/hidden treatment — the ambiguity being guarded against
is "could this headcode mean a different train," not "did the resolver have to break a tie."
`matchBasis` in the response is unaffected and still reports `headcode_only` either way — it
genuinely was found by headcode alone; only public-visibility eligibility changed. The
underlying `match_confidence` written to `train_run` (and therefore what step-chain is willing to
propagate forward, docs/adr/0007) is also unaffected — this is a narrower, response-shaping change
only, not a re-grading of the tier's own confidence for lineage purposes.

`packages/database/src/runResolution.ts`: `resolveFreshRunMatch` computes
`runningNationwideCount` via `candidatesRunningOnAny` (the same function `resolveRunMatch` uses
internally) over the unscoped candidate set, and folds it into `isSolidMatch`. Tests:
`currentRun.integration.test.ts` — rewrote the single-unscoped-candidate case to expect a 200 with
reduced public detail (previously 404), added a new case confirming two unscoped candidates still
404s even when the resolver itself resolves cleanly via STP precedence (Overlay beats Permanent).

## Third addendum (2026-09-15): count distinct trains, extend solid to a clean TRUST-activation win, and propagate confidence into storage

Two further real reports, investigated together per the owner's request to look for anything else
of the same shape rather than fixing one at a time: PX 0107/headcode `1Y61` (already covered by
the second addendum above) and **PX 0188/headcode `1C55`** — internally resolved correctly to
`G89047` (confirmed against the reference site) via a clean `trust_activation` win, but still
hidden from the public because the _second_ addendum's "exactly one running candidate" rule only
ever looked at raw schedule **rows**, not distinct physical trains.

**Bug 1 — counting rows instead of trains**: a single `cif_train_uid` routinely has both a
Permanent and an Overlay/New row simultaneously satisfying today's date and day-of-week bitmask,
before STP precedence even runs (seen repeatedly this session, e.g. headcode `1S40`'s `G38840`).
The second addendum's `runningNationwideCount` counted these as _two_ candidates, wrongly treating
a genuinely unique train as if it might collide with itself, and keeping a perfectly safe match
hidden. Fixed: count distinct `cif_train_uid` values among the running candidates, not rows.

**Bug 2 (the actual `1C55` case) — a clean TRUST-activation win among multiple trains stayed
hidden**: the second addendum only ever elevated the _count-of-one_ case. But a `trust_activation`
row isn't inferred from the headcode text at all — it's created by Network Rail's own systems
already linked to one specific `cif_schedule_id`, independent of anything this resolver matched
on. The real risk this tier exists to guard against — two genuinely different trains sharing a
headcode _both_ getting activated today — is already caught one level up in `resolveRunMatch`
itself: two activated candidates report `ambiguous`, never a silent pick (CLAUDE.md rule 7,
already tested since Milestone 34). So by the time `resolveRunMatch`'s own `basis ===
"trust_activation"` reaches `resolveFreshRunMatch`, it's already _the_ unique activated candidate
among however many trains/rows shared the headcode — solid regardless of how many there were.
`stp_precedence` alone, across _different_ train_uids, carries no equivalent guarantee (an Overlay
outranking a Permanent is only meaningful within one train's own schedule variants, not as a way
to arbitrate between two unrelated trains) — that basis still needs the distinct-train-count check.

`isSolidMatch` is now: position-scoped (unchanged) **or** `matchResult.basis ===
"trust_activation"` **or** exactly one distinct train_uid running nationwide.

**Bug 3 — the smarter reasoning above only reached the ephemeral API response, not what
`upsertResolvedLink` actually stores.** `train_run.match_confidence` was derived purely from
`matchBasis` via `confidenceForBasis` (`headcode_only` → `weak`, else → `solid`) — a strictly
narrower rule than `isSolidMatch` above, and completely blind to it. This meant only _freshly_
resolved occupancies benefited from the smarter reasoning; anything already linked (a prior
resolution, or a link inherited via step-chain) kept whatever `weak`/`solid` label was computed
under the old, narrower rule — confirmed live: a fresh occupancy returned full public detail
immediately, while an already-linked `headcode_only` occupancy from before this fix stayed hidden
until it naturally re-resolved. Fixed by threading the actual computed value through instead of
re-deriving it: `ResolvedRunToLink` gains a `matchConfidence: "solid" | "weak"` field, supplied by
every caller from its own `resolveFreshRunMatch`-computed `isSolidMatch` (`currentRun.ts`'s fresh
branch, `sweepFreshResolution`, `attemptStepChainUpgrades`), and `upsertResolvedLink` writes that
value directly rather than calling `confidenceForBasis`. This also means step-chain upgrades
(docs/adr/0007 second addendum) now correctly recognize _more_ previously-weak links as eligible
for upgrade once a later berth confirms them, since "eligible for upgrade" already keyed off the
same stored `match_confidence`. `confidenceForBasis` itself is left in place (still correct as a
general-purpose rule, still tested) — it's simply no longer this call site's source of truth.
Links established via `step_chain`/`boundary_correlated` (a separate code path that points at an
_existing_ `train_run` row rather than creating a new one) are unaffected — they already inherit
confidence for free by pointing at the same row, never re-deriving it.

Tests: `currentRun.integration.test.ts` — new cases for a same-train Permanent+Overlay pair (must
be solid), a clean TRUST-activation win among two different trains sharing a headcode (the actual
`1C55` scenario), and confirmation that an STP-only tie-break across two _different_ trains (no
activation, no position data) still correctly stays hidden.

## Fourth addendum (2026-09-15): exclude an activated candidate demonstrably already gone, using its own TRUST movement history

Real report: PX 0237, headcode `1M11`. `W33973` (Avanti Glasgow→Euston) was activated that
morning — the correct match. A same-headcode Caledonian Sleeper working, `C04561`, had also been
activated the evening before, genuinely within the two-date probe window, and its own resolved
traffic day correctly came out to yesterday — so the third addendum's per-date activation check
(correctly) still counted it, reporting `ambiguous`. But `C04561`'s own `trust_movement` history,
confirmed directly, already showed it passing straight through this exact STANOX at 03:11 that
morning and continuing on to what's almost certainly Euston by 06:39 — over eight hours before the
current occupancy even opened. It was never a genuine collision; it was a real train that had
already finished its journey hours earlier.

**Decision** (owner-proposed mechanism, confirmed against the real data before building):
positive TRUST movement evidence outranks every tier below it — it's direct physical evidence, not
inference — so it's applied as a filter over the _entire_ candidate pool, before any tier runs
(not just within `trust_activation`): a schedule whose own movement reports already show it at or
beyond this berth's calling point is removed before STP precedence or `station_berth_timetable`
ever get a chance at it either, not just before the activation-ambiguity check.

Two decisions, worked through and confirmed before implementing:

1. **Where it belongs**: inside/before the `trust_activation` tier, never as a later fallback
   tier. Movement data is TRUST-sourced, same evidence class as the activation itself and stronger
   than STP precedence or scheduled-time-closeness — placing it _after_ those weaker tiers would
   let a wrong answer from weaker evidence win before the stronger evidence was ever consulted.
2. **Absence of movement data**: never treated as evidence of anything, in either direction. A
   candidate with no movement reports could mean "hasn't started yet" (a completely normal, still
   -live candidate) or "a data gap in garner's mirror" (a known occurrence) — those can't be told
   apart from absence alone, so only _positive_ evidence (a movement report at or beyond this
   berth's own calling point) ever excludes a candidate.

`resolveRunMatch` (`packages/domain/src/schedule/resolveRunMatch.ts`) gains an optional 5th
parameter, `alreadyPassedScheduleIds?: ReadonlySet<string>` — filters `candidates` before
`candidatesRunningOnAny` even runs, so every downstream tier sees the same reduced pool.
`packages/database/src/runResolution.ts` gains `findAlreadyPassedScheduleIds`: for each schedule
with _some_ activation in the window (only worth checking when position-scoped and more than one
such schedule exists — the only situation this filter could change anything), resolves that
schedule's own calling-point `seq_no` at this berth's tiploc(s), then checks whether its
`trust_id`'s `trust_movement` rows include any location whose `seq_no` (in that same schedule's
own sequence) is at or beyond it — a single query, joining `location_reference` to translate each
movement's STANOX back to the schedule's own TIPLOC sequence.

Tests: `resolveRunMatch.test.ts` (+4 pure cases: the real PX 0237/1M11 scenario, confirmation two
activated candidates stay ambiguous absent movement evidence, confirmation the filter also
protects the STP tier not just the activation check, and every-candidate-already-passed →
`unmatched`), `currentRun.integration.test.ts` (+2 integration cases: the real scenario end-to-end,
and confirmation two activated candidates with no movement evidence either way still correctly
stay ambiguous).

## Addendum (2026-10-01): which date, and which schedule

Probing both dates was not enough for a train running on consecutive nights: the schedule is valid
on both, and the most recent date was always preferred. The date is now the occurrence whose
origin departure is nearest to now (`ServiceDateChoice`). Separately, STP precedence is decided per
train UID from every schedule of that UID, cancellations included (`governsDate`), and never across
different trains sharing a headcode. See IMPLEMENTATION_PLAN Milestone 87.

## Amendment (2026-10-31): correct a link a day out

**Superseded on 2026-11-01** by the amendment below, which fixes the cause instead: the sweep
described here was removed before it had moved any link (`run_link_day_correction` was empty).
Kept for the record.

Owner report: 27 trains in five days showed about a day late (ADR 0021 second amendment). Each
stood in its berth before midnight for a departure after it (CL 0305 092N08 from 23:24 on the
28th, booked away 05:52 on the 29th). The probe is today and yesterday only, so the occupancy was
linked to the earlier day's run, and a link is never resolved again once made.

The probe itself is unchanged: considering "tomorrow" needed guards (at the origin, within 12
hours, today's run not still active) that each left cases (starting short, early set-up, origins
without SMART) the owner judged too convoluted. Instead a wrong link is detected exactly, and
corrected once the evidence exists:

- **Mismatch:** an open occupancy whose linked run is paired with an activation (the newest since
  the run's traffic day began, as the delay colours and held-train estimates pair it) whose TRUST
  ID names a different day. A TRUST ID ends in the day of the month the run leaves its origin
  (`trafficDayFromTrustId`).
- **Correction:** `run-lineage` looks for mismatches every 30 seconds (mapped areas, as fresh
  resolution) and resolves the berth again with the unchanged resolver. The link moves only if
  the result is the **same schedule on the activation's day**; anything else leaves it as it is
  (retried at most once a minute). 305N64, activated at 23:05 for 00:05 the next day, therefore
  moves just after midnight, when the resolver can give that day.
- **Write:** only that one link is repointed, to the live run of that schedule and day (reused, or
  created), under the same advisory lock as `upsertResolvedLink`. The old run is never superseded:
  it was a real train on its own day and keeps the rest of its journey. Later steps inherit the
  new run by step chain. Each move is a `run_link_day_correction` row (migration 0064).
- Switched by `RUN_LINK_DAY_CORRECTION_ENABLED` (default on).

A correctly linked train has no mismatch and is never looked at. Until its activation arrives, a
train set up before midnight stays linked to the earlier (finished) run, as before: no estimate is
made for a finished run, but its popup and colour can show that run overnight.

**Undo**, in this order, if the corrections turn out to be wrong:

1. Stop new moves: set `RUN_LINK_DAY_CORRECTION_ENABLED=false` in the Portainer stack's
   environment and update the stack (no code change needed; `run-lineage` logs
   `day correction disabled` on start).
2. Restore every link it moved, from its audit rows (only links still pointing at the run the
   correction chose are touched):

   ```sql
   update berth_occupancy_run_link l
      set train_run_id = c.old_train_run_id, updated_at = now()
     from run_link_day_correction c
    where l.berth_occupancy_id = c.berth_occupancy_id
      and l.occupancy_entered_at = c.occupancy_entered_at
      and l.train_run_id = c.new_train_run_id;
   ```

   Occupancies the train stepped into afterwards inherited the new run by step chain. Re-link
   them for the window concerned with `repair-run-links --correct --areas <areas> --from <first corrected_at>
--to <now>` (or the admin "link backfill" job with "correct" ticked). Runs the correction
   created (`new_run_created`) can be left: with no links they show nowhere.

3. Revert the code: `git revert` the commit that added this amendment (it also reverts the
   estimator's TRUST-ID day, ADR 0021 second amendment).
4. Only after the revert is deployed: `drop table run_link_day_correction;` and
   `delete from schema_migrations where name = '0064_run_link_day_correction.sql';`.

## Amendment (2026-11-01): a finished run is not the current train

Owner report, 00:20 on Sunday 1 November: two units stabled at Carlisle (CL 0302 2C38, CL 0305
1J70), interposed at 21:55 and 23:03 for Sunday morning, showed Saturday's runs. On Sundays they
run under Sunday-only schedules; Saturday's Mon–Sat schedule had a TRUST activation (Saturday's,
its run long finished at Whitehaven and Middlesbrough) and Sunday's had none yet, and "activated"
wins. The check that rules out a finished run (fourth addendum) only ran when two or more
schedules were activated, and judged each against its latest activation, not its own day's.

The same flaw caused the day-out links of the 2026-10-31 amendment (092N08 at 23:24 was linked to
the 28th's finished run), which that amendment only corrected afterwards. The rule now:

- **An activated run counts only if it hasn't finished.** The finished-run check runs whenever
  the berth is position-scoped and any candidate is activated (was: two or more activated, and
  more than one candidate). Each candidate is judged by the activation for the day it resolved
  to; with none for that day it has no movements to be judged by and stays in.
- **A run that finished counts only if it finished here, and only when nothing else fits.** If no
  candidate is left, a yesterday-resolved run whose terminating report is at this berth's own
  location (and nothing reported beyond it) is the answer: the train that arrived last night and
  is still standing. A run that went on elsewhere is never brought back, and today's run still
  beats one that finished here (the fourth addendum's 5Z01 rule).
- **Standing trains keep being resolved.** Fresh resolution used to try an occupancy only in its
  first 15 minutes. A train set up the evening before is `unmatched` until its own run can be
  matched (after midnight, or when its activation arrives), so `run-lineage` now also retries
  open, unlinked occupancies up to 12 hours old once a minute, each at most every 10 minutes
  (production at 01:30 on a Sunday: 280 of them, 65 ms to find).
- **The day-correction sweep is removed** (code, flag and compose variable): with these rules the
  resolver no longer makes the links it corrected.

Replayed on production at 01:22, every train standing in a mapped berth (239), deployed rule
against new: 220 unchanged, 19 changed. Nine moved from Saturday's finished run to Sunday's (both
Carlisle units, CL 0046 6X81, G1 2REC 5S93, GP02 1S95, GP07 2Y65, WJ COUT 1B66, XA 0503 1A88,
XA 0509 2I02); seven became unmatched, each a description left behind by a run that finished
elsewhere (PX C2LH 1C62 terminated at Barrow at 00:31); two unmatched trains now match the run
that finished where they stand (AW GR20 2N19, GR26 2N21). One remains questionable: G1 BR01 5S26
moves from Saturday's one-day overlay (activated, finished) to the permanent schedule it replaced,
never activated — a pre-existing edge, not addressed.

**Undo**, if the new matching turns out worse:

1. Revert the code: `git revert <this commit>` and push (CI deploys it). That restores the old
   resolver rule, the 15-minute-only fresh resolution and the day-correction sweep with its flag
   (`RUN_LINK_DAY_CORRECTION_ENABLED`, default on). Nothing in the database needs restoring
   first: links this change made are ordinary `resolved` links, and the next resolution under
   the old code treats them as it always did.
2. To re-link a window under the old rule, run `repair-run-links --correct --areas <areas>
--from <start> --to <end>` (or the admin "link backfill" job with "correct" ticked).
3. The `run_link_day_correction` table (migration 0064) is left in place, unused. It held no rows
   when the sweep was removed. Drop it only with the owner's approval:
   `drop table run_link_day_correction;` and
   `delete from schema_migrations where name = '0064_run_link_day_correction.sql';` — and not if
   the revert in step 1 is deployed, since the restored sweep writes to it.
