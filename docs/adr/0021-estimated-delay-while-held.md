# ADR 0021 — Estimated delay for a train that is held

Status: **Accepted in principle** (2026-10-26). Owner answered the open questions the same day.
The allowance check has been run against production (see "Evidence"). Milestone 97a (maintenance jobs and berth allowances) is built; 97b and 97c are not yet.

## Context

Delay colours (Milestone 82) come only from the train's latest TRUST report. TRUST reports at
timing points, so a train can sit still for a long time with no new report. During that time its
colour is frozen at whatever the last report said:

- a train booked to leave Lancaster at 14:00 that is still there at 15:48 shows the lateness of
  its _arrival_, when it is really at least 108 minutes late;
- a train held at a signal between timing points for 30 minutes after a "5 late" report still
  shows green, when it is about 35 late;
- a train waiting at its origin shows green (activated, no report) until it departs, however
  late that departure is.

Milestone 82 was explicitly "never a prediction and never extrapolated". This ADR changes that,
narrowly: it adds a **lower bound** that only ever makes a held train look _later_ than TRUST says,
and only while the train is demonstrably not moving.

## Decision

While a matched train's current berth occupancy is still open, **and no TRUST report for the run
has arrived since it entered that berth**, its lateness is the worst of:

1. **Reported**: the latest TRUST report's lateness, exactly as now.
2. **Booked timing point** (stations, loops, junctions, the origin): if this berth maps (by SMART
   STANOX → TIPLOC) to a location in the train's schedule that it has not yet left, lateness is at
   least `now − booked WTT departure` (or the WTT pass time for a pass). A booked dwell is
   allowed for automatically, since only the departure time counts.
3. **Held in a plain berth**: lateness is at least
   `reported lateness at entry + time in berth − berth allowance − booked allowances still ahead`
   (see below for both allowances). Applied only when the run already has a TRUST report (owner,
   2026-10-26). A train held before its first report uses rule 2 only.

As soon as TRUST reports again the estimate is dropped and the report is shown as it is, even if
it is lower. The estimate never makes an early train look earlier.

No estimate is made when:

- the train is not matched to a run (ambiguous or unmatched: there's no schedule to compare with);
- the run has terminated (an arrival-at-destination or terminated report), or the berth is at the
  schedule's destination;
- the run is cancelled (see the 2026-10-26 cancellation rule);
- the TD area has an open feed gap (a "stationary" train may just be missing steps);
- the same headcode has since appeared in another berth of the area or a boundary neighbour, a
  likely missed step (description matching is not identity, CLAUDE.md rule 5, but here it only
  ever _suppresses_ an estimate, never makes one);
- the berth is a pseudo-berth (`COUT` and other fringe / exit codes).

### Not overstating a plain-berth hold

Rule 3 could overstate in three ways. Each is handled:

1. **Normal time in the berth.** Every berth takes some time to pass through. Subtracting the
   berth's own normal occupancy time (below) covers it.
2. **Recoverable allowances.** Schedules carry engineering, pathing and performance allowances
   (on 1S66 W85191 today: half a minute to 3 minutes at individual timing points). A train
   standing at a signal may be using time the timetable already gave it, and it'll get that time
   back by the next timing point. An allowance recorded at a timing point belongs to the section
   _after_ it (measured, see "Evidence"). So rule 3 subtracts the allowances recorded at the
   train's last reported location and at every later location before the next one TRUST
   reports at (one with a STANOX). The estimate is then a lower bound on its lateness at that
   next report, not just "minutes stood still". All of the allowance is subtracted, although
   trains really recover about 70–80% of it, so this errs low.
3. **A train that is not really stationary** (a missed TD step). Handled by the feed-gap and
   "headcode seen elsewhere" guards above. It can't be ruled out completely, which is why the
   popup says "estimated".

What's left is deliberately conservative. Where the berth allowance mixes stopping and
non-stopping trains (a platform berth some trains pass through), the allowance is larger, so the
estimate shows _less_ delay, never more.

### Berth allowance: normal occupancy with outliers removed

Per berth, over the last 14 days of occupancies:

- remove outliers with a Tukey fence: drop any occupancy longer than `Q3 + 1.5 × (Q3 − Q1)`;
- the allowance is the 95th percentile of what's left (floor 1 minute);
- a berth with fewer than 50 occupancies uses a default of 3 minutes.

Checked on production (PX, 17–23 October, one query, 4.2 s):

| Berth | Trains | Median | Fence | Allowance (p95 trimmed) | Dropped | Raw max |
| ----- | ------ | ------ | ----- | ----------------------- | ------- | ------- |
| BLDM  | 816    | 4.7    | 7.6   | **6.2**                 | 4.9%    | 189     |
| 0107  | 565    | 4.1    | 7.7   | **5.9**                 | 7.4%    | 193     |
| 0434  | 425    | 3.2    | 11.0  | **8.5**                 | 10.1%   | 62      |
| A336  | 542    | 6.3    | 13.0  | **10.1**                | 3.1%    | 24      |
| 0251  | 806    | 1.1    | 2.9   | **2.2**                 | 0.4%    | 3       |
| 0267  | 665    | 0.8    | 1.2   | **1.0**                 | 2.1%    | 2       |
| 0208  | 571    | 0.5    | 0.8   | **1.0** (floor)         | 8.2%    | 2       |

(minutes). The fence removes the anomalies cleanly: BLDM's 189-minute stand becomes an allowance
of 6.2 minutes, not the 13 minutes a plain 99th percentile gives.

**Calculated on request, not nightly (owner, 2026-10-26).** An admin runs "Recalculate berth
allowances" for a TD area (or all mapped areas) from the admin pages. A berth's normal time
barely changes from week to week, so a nightly job would mostly redo the same work. The result
is stored in `berth_dwell_profile` (td_area, berth, allowance minutes, sample size, quartiles,
calculated_at, window). It's a derived projection of `berth_occupancy` and can be rebuilt any
time (CLAUDE.md rule 3). One area takes a few seconds (a week of PX: 4.2 s). Areas run one after
another, so the live site is never starved by one big read.

- TD capture is nationwide, so a newly mapped area already has its occupancy history. The
  allowances can be calculated straight away; nothing needs backfilling first.
- A berth with no profile yet (a new map before anyone runs the job, or a rarely used berth)
  uses the 3-minute default, so the estimate still works, just more cautiously.
- The admin page shows each area's last calculation date, so a stale one (for example after the
  December timetable change) is easy to spot.

### Who sees it (owner, 2026-10-26)

- **Delay is shown to everyone**, not just logged-in users. The public popup gains its delay line
  (`12 late`, or `Estimated 34 late`). Previously only the band reached anonymous visitors, and
  minutes were logged-in only (Milestone 82). The public popup still appears only for solid
  matches, as now.
- **The map looks the same** for an estimated band: same colours, no special outline. The popup
  marks it: `Estimated 34 late — standing 30 min at <berth>; last report 5 late at <location>`.

### Worked scenarios

| #   | Situation                                                                                        | Reported | Estimate                                                | Shown            |
| --- | ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------- | ---------------- |
| 1   | Booked dep Lancaster 14:00 (WTT), arrived on time, still in the platform berth at 15:48          | 0L       | Rule 2: 15:48 − 14:00 = **108L**                        | severe (red)     |
| 2   | Arrives 5L at a station with a 20-min booked dwell; 30 min later still there                     | 5L       | Rule 2: booked dep = arr + 20; now = arr + 35 → **15L** | minor            |
| 3   | 5L at the last report; enters a plain berth (allowance 1 min), 2 min of allowances ahead, 30 min | 5L       | Rule 3: 5 + 30 − 1 − 2 = **32L**                        | moderate         |
| 4   | Same as 3, but standing 8 min                                                                    | 5L       | Rule 3: 5 + 8 − 1 − 2 = 10L                             | on time          |
| 5   | Freight 10E, held in a loop timing point, booked dep 11:40, now 11:35                            | 10E      | Rule 2: 11:35 − 11:40 = −5 → no change                  | on time          |
| 6   | Interposed at origin 40 min early, booked dep 07:10, now 07:05                                   | none     | Rule 2: −5 → no change                                  | as now           |
| 7   | Same train at origin, booked dep 07:10, now 07:32, not departed                                  | none     | Rule 2: **22L**                                         | minor            |
| 8   | Terminated at destination 10 min ago, still in the platform                                      | 3L       | none (terminated)                                       | as now           |
| 9   | Overnight: traffic day 25 Oct, booked dep 00:20 "next day" (26 Oct), now 00:50                   | 2L       | Rule 2: **30L**, using the traffic day + next-day flag  | moderate         |
| 10  | A TRUST report arrives saying 12L while the estimate was 32L                                     | 12L      | estimate dropped; TRUST wins                            | moderate→on time |
| 11  | Held before its first TRUST report, between timing points                                        | none     | none (rule 3 needs a report)                            | as now           |
| 12  | 5L, standing 30 min, but the same headcode was interposed two berths ahead 10 min ago            | 5L       | none (likely missed step)                               | on time          |

Scenario 9 is the timezone/date boundary case: CIF WTT times are local (Europe/London) on the
run's traffic day, with `next_day` for times after midnight. They're converted with the same
calendar-date-only arithmetic as ADR 0008, never "date + 24 h", including on a 25-hour or 23-hour
clock-change day.

## Evidence: which section an allowance belongs to

CIF records each allowance against a timing point. Measured on production from 3,000 runs
activated 06:00–09:00 UTC on Saturday 24 October: 46,132 reported locations, giving each pair of
consecutive TRUST reports on a run as a section. Engineering + pathing + performance allowances
were summed under each reading:

| Sections where the allowance sits…            | All trains: n | Avg change in lateness | Late trains (≥ 3L): n | Avg change |
| --------------------------------------------- | ------------- | ---------------------- | --------------------- | ---------- |
| nowhere (no allowance)                        | 32,935        | +0.17 min              | 8,202                 | +0.13 min  |
| at the section's **start** only (avg 1.1 min) | 4,697         | **−0.49 min**          | 1,647                 | **−0.70**  |
| at the section's **end** only (avg 1.1 min)   | 4,599         | +0.32 min              | 1,589                 | +0.34      |

Time is recovered only in sections whose _starting_ point carries the allowance. So an allowance
recorded at a timing point applies to the run from that point to the next. Late trains recover
about 0.8 of a 1.15-minute allowance. The query took about 1 s on temporary tables.

## Design

- **Pure domain function** `estimateHeldLateness(...)`, fixture-tested with every scenario above.
- **Berth allowance:** `berth_dwell_profile`, written by an admin-triggered job (above).
- **Admin "Area maintenance" jobs.** The API has no job runner, so there's a small queue table
  (`maintenance_job`: kind, TD areas, requested_by, status, progress, result, timestamps). An
  admin action inserts a row (audited like other admin actions). The `worker` container polls it,
  runs one job at a time, and writes progress the page can show. Two kinds to start with:
  - `berth_allowances` — recalculate allowances for the chosen areas;
  - `link_backfill` — today's `repair-run-links --areas`, the step a newly mapped area needs
    before its history gets delay colours. This replaces running that
    command by hand.
- **Sweep** in `ingest-garner`, next to the existing delay-band projection, every ~30 s. It reads
  the open, linked occupancies in mapped areas (a few hundred to a few thousand rows, using the
  open-occupancy index) and computes the estimate. When the _band_ changes it records the change
  and pushes `delay.updated` with `estimated: true`. Bands change only at 15/30/60, so pushes stay
  rare.
- **`estimated_delay_band_change`**: a separate table, never mixed into `trust_delay_band_change`,
  keyed by occupancy so re-runs are idempotent. Playback (`findMapDelaysAt`) reads both and takes
  the later in force, so history shows the same colours the live map did.
- **Popup:** the public and logged-in views both get the delay line. The estimate's working
  ("standing 30 min…") is in both.

Scope: mapped areas, because run links (and so schedules) exist only there. The cost is one small
query per sweep, plus a few seconds per area whenever an admin recalculates allowances. So
nationwide would be affordable later if links ever go nationwide.

## Consequences

- Held trains change colour while they're held, which is what the owner asked for. Trains
  waiting late at their origin stop showing green.
- It is an estimate. A missed TD step the guards don't catch can make a train look later than it
  is, until the next TRUST report.
- The public popup now carries delay minutes (a change from Milestone 82's band-only public view).
