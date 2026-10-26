import {
  BERTH_ALLOWANCE_DEFAULT_MINUTES,
  TD_PROJECTION_VERSION,
  decodeTrustMovementFlags,
  estimateHeldDelay,
  londonWallClockToInstant,
  parseCifAllowanceMinutes,
  parseCifTimeToMinutes,
  scheduleDayOffset,
  signedVariationMinutes,
  type HeldDelayInput,
  type HeldDelayResult,
  type RunEstimateState,
} from "@railway/domain";
import type { Queryable } from "./checkpoint.js";
import { withinTrustRun } from "./runResolution.js";

/**
 * Milestone 97b (docs/adr/0021): the reads and writes behind `ingest-garner`'s held-train sweep.
 * The sweep itself (and its caches) lives in `apps/worker/src/garner/heldDelaySweep.ts`; the
 * estimate rule is `estimateHeldDelay` in `@railway/domain`.
 */

/** Same bound as `findOpenBerthsForTrustIds`: an occupancy older than this is never looked at. */
const OCCUPANCY_LOOKBACK = "24 hours";

/** A train standing in a mapped berth, linked to a run whose schedule was activated. */
export interface HeldTrainCandidate {
  tdArea: string;
  berth: string;
  description: string;
  occupancyId: string;
  enteredAt: Date;
  runKey: string;
  matchConfidence: "solid" | "weak";
  cifScheduleId: string;
  /** `YYYY-MM-DD`. */
  trafficDay: string;
  trustId: string;
  activatedAt: Date;
}

/**
 * Every currently occupied berth among `berths` whose open occupancy is linked to a run with a
 * TRUST activation on its traffic day. Same shape and rules as `findOpenBerthsForTrustIds` (start
 * from the berths, one index entry per berth), so the sweep and the delay push always agree on
 * which run a berth holds.
 */
export async function findHeldTrainCandidates(
  db: Queryable,
  berths: ReadonlyArray<{ tdArea: string; berth: string }>,
): Promise<HeldTrainCandidate[]> {
  if (berths.length === 0) return [];
  const { rows } = await db.query<{
    td_area: string;
    berth_code: string;
    description: string;
    occupancy_id: string;
    entered_at: Date;
    run_key: string;
    match_confidence: "solid" | "weak";
    cif_schedule_id: string;
    traffic_day: string;
    trust_id: string;
    activated_at: Date;
  }>(
    `with wanted as (
       select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code
     ),
     cur as materialized (
       select distinct bcs.td_area, bcs.berth_code from berth_current_state bcs
       join wanted w on w.td_area = bcs.td_area and w.berth_code = bcs.berth_code
       where bcs.projection_version = $3 and bcs.description is not null
     ),
     occ as materialized (
       select cur.td_area, cur.berth_code, o.description, o.id, o.entered_at
       from cur
       cross join lateral (
         select o.id, o.entered_at, o.description, o.left_at from berth_occupancy o
         where o.projection_version = $3 and o.td_area = cur.td_area
           and o.berth_code = cur.berth_code and o.entered_at > now() - $4::interval
         order by o.entered_at desc limit 1
       ) o
       where o.left_at is null
     ),
     runs as materialized (
       select occ.*, r.id as run_id, r.cif_schedule_id, r.traffic_day, r.match_confidence
       from occ
       join berth_occupancy_run_link l
         on l.berth_occupancy_id = occ.id and l.occupancy_entered_at = occ.entered_at
       join train_run r on r.id = l.train_run_id
       where r.superseded_by is null and r.cif_schedule_id is not null
     )
     select runs.td_area, runs.berth_code, runs.description, runs.id::text as occupancy_id,
            runs.entered_at, runs.run_id::text as run_key, runs.match_confidence,
            runs.cif_schedule_id::text as cif_schedule_id, runs.traffic_day::text as traffic_day,
            a.trust_id, a.created as activated_at
     from runs
     cross join lateral (
       select ta.trust_id, ta.created from trust_activation ta
       where ta.cif_schedule_id = runs.cif_schedule_id
         and ta.created >= (runs.traffic_day)::timestamp at time zone 'Europe/London'
       order by ta.created desc limit 1
     ) a`,
    [
      berths.map((b) => b.tdArea),
      berths.map((b) => b.berth),
      TD_PROJECTION_VERSION,
      OCCUPANCY_LOOKBACK,
    ],
  );
  return rows.map((row) => ({
    tdArea: row.td_area,
    berth: row.berth_code,
    description: row.description,
    occupancyId: row.occupancy_id,
    enteredAt: row.entered_at,
    runKey: row.run_key,
    matchConfidence: row.match_confidence,
    cifScheduleId: row.cif_schedule_id,
    trafficDay: row.traffic_day,
    trustId: row.trust_id,
    activatedAt: row.activated_at,
  }));
}

export interface RunTrustState {
  trustId: string;
  latestReport: {
    locStanox: string | null;
    flags: number | null;
    timetableVariation: number | null;
    actualAt: Date;
  } | null;
  /** When the run's newest report arrived (`trust_movement.created`). */
  latestReceivedAt: Date | null;
  /** The run's newest cancellation-family row: `reinstate <> 0` is a reinstatement. */
  latestCancellation: { type: string | null; reinstate: number } | null;
}

/** Each run's latest TRUST report and cancellation state, bounded to the run (`withinTrustRun`). */
export async function loadRunTrustStates(
  db: Queryable,
  runs: ReadonlyArray<{ trustId: string; activatedAt: Date }>,
  /** Milestone 97d: only what had been received by this moment (a backfill replay). */
  asOf: Date | null = null,
): Promise<Map<string, RunTrustState>> {
  const out = new Map<string, RunTrustState>();
  if (runs.length === 0) return out;
  const { rows } = await db.query<{
    trust_id: string;
    loc_stanox: string | null;
    flags: number | null;
    timetable_variation: number | null;
    actual_timestamp: Date | null;
    received_at: Date | null;
    cancel_type: string | null;
    cancel_reinstate: number | null;
    has_cancellation: boolean;
  }>(
    `select p.trust_id, m.loc_stanox, m.flags, m.timetable_variation, m.actual_timestamp,
            r.received_at, c.type as cancel_type, c.reinstate as cancel_reinstate,
            c.trust_id is not null as has_cancellation
       from unnest($1::text[], $2::timestamptz[]) as p(trust_id, activated_at)
       left join lateral (
         select m.loc_stanox, m.flags, m.timetable_variation, m.actual_timestamp
           from trust_movement m
          where m.trust_id = p.trust_id and m.actual_timestamp is not null
            and ${withinTrustRun("m.created", "p.activated_at")}
            and ($3::timestamptz is null or m.created <= $3::timestamptz)
          order by m.actual_timestamp desc, m.created desc limit 1
       ) m on true
       left join lateral (
         select max(m.created) as received_at from trust_movement m
          where m.trust_id = p.trust_id and ${withinTrustRun("m.created", "p.activated_at")}
            and ($3::timestamptz is null or m.created <= $3::timestamptz)
       ) r on true
       left join lateral (
         select c.trust_id, c.type, c.reinstate from trust_cancellation c
          where c.trust_id = p.trust_id and ${withinTrustRun("c.created", "p.activated_at")}
            and ($3::timestamptz is null or c.created <= $3::timestamptz)
          order by c.created desc limit 1
       ) c on true`,
    [runs.map((r) => r.trustId), runs.map((r) => r.activatedAt), asOf],
  );
  for (const row of rows) {
    out.set(row.trust_id, {
      trustId: row.trust_id,
      latestReport: row.actual_timestamp
        ? {
            locStanox: row.loc_stanox,
            flags: row.flags,
            timetableVariation: row.timetable_variation,
            actualAt: row.actual_timestamp,
          }
        : null,
      latestReceivedAt: row.received_at,
      latestCancellation: row.has_cancellation
        ? { type: row.cancel_type, reinstate: Number(row.cancel_reinstate ?? 0) }
        : null,
    });
  }
  return out;
}

export interface ScheduleLocationRow {
  seqNo: number;
  tiploc: string;
  recordIdentity: string;
  arrival: string | null;
  departure: string | null;
  pass: string | null;
  nextDay: boolean;
  engineeringAllowance: string | null;
  pathingAllowance: string | null;
  performanceAllowance: string | null;
}

/** Every calling/timing point of each schedule, in order. */
export async function loadScheduleLocations(
  db: Queryable,
  scheduleIds: readonly string[],
): Promise<Map<string, ScheduleLocationRow[]>> {
  const out = new Map<string, ScheduleLocationRow[]>();
  if (scheduleIds.length === 0) return out;
  const { rows } = await db.query<{
    cif_schedule_id: string;
    seq_no: number;
    tiploc_code: string;
    record_identity: string;
    arrival: string | null;
    departure: string | null;
    pass: string | null;
    next_day: boolean;
    engineering_allowance: string | null;
    pathing_allowance: string | null;
    performance_allowance: string | null;
  }>(
    `select cif_schedule_id::text as cif_schedule_id, seq_no, tiploc_code, record_identity,
            arrival, departure, pass, next_day, engineering_allowance, pathing_allowance,
            performance_allowance
       from cif_schedule_locations
      where cif_schedule_id = any($1::bigint[])
      order by cif_schedule_id, seq_no`,
    [[...scheduleIds]],
  );
  for (const row of rows) {
    const list = out.get(row.cif_schedule_id) ?? [];
    list.push({
      seqNo: row.seq_no,
      tiploc: row.tiploc_code,
      recordIdentity: row.record_identity,
      arrival: row.arrival,
      departure: row.departure,
      pass: row.pass,
      nextDay: row.next_day,
      engineeringAllowance: row.engineering_allowance,
      pathingAllowance: row.pathing_allowance,
      performanceAllowance: row.performance_allowance,
    });
    out.set(row.cif_schedule_id, list);
  }
  return out;
}

/** The STANOX(es) each TIPLOC is at (CORPUS, via `location_reference`). */
export async function loadTiplocStanoxes(
  db: Queryable,
  tiplocs: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (tiplocs.length === 0) return out;
  const { rows } = await db.query<{ tiploc: string; stanox: string }>(
    `select tiploc, stanox from location_reference
      where tiploc = any($1::text[]) and stanox is not null`,
    [[...tiplocs]],
  );
  for (const row of rows) out.set(row.tiploc, row.stanox);
  return out;
}

/** The STANOX(es) SMART places each berth at, keyed `area|berth`. */
export async function loadBerthStanoxes(
  db: Queryable,
  berths: ReadonlyArray<{ tdArea: string; berth: string }>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (berths.length === 0) return out;
  const { rows } = await db.query<{ td_area: string; berth: string; stanoxes: string[] }>(
    `select w.td_area, w.berth, array_agg(distinct s.stanox) as stanoxes
       from unnest($1::text[], $2::text[]) as w(td_area, berth)
       join smart_berth_step s
         on s.td_area = w.td_area and (s.from_berth = w.berth or s.to_berth = w.berth)
      where s.stanox is not null
      group by w.td_area, w.berth`,
    [berths.map((b) => b.tdArea), berths.map((b) => b.berth)],
  );
  for (const row of rows) out.set(`${row.td_area}|${row.berth}`, row.stanoxes);
  return out;
}

/** Each berth's allowance (minutes) from `berth_dwell_profile`, keyed `area|berth`. A berth
 * with no row is absent; the caller uses the default. */
export async function loadBerthAllowances(
  db: Queryable,
  berths: ReadonlyArray<{ tdArea: string; berth: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (berths.length === 0) return out;
  const { rows } = await db.query<{ td_area: string; berth_code: string; allowance: string }>(
    `select p.td_area, p.berth_code, p.allowance_minutes::text as allowance
       from berth_dwell_profile p
       join unnest($1::text[], $2::text[]) as w(td_area, berth)
         on w.td_area = p.td_area and w.berth = p.berth_code`,
    [berths.map((b) => b.tdArea), berths.map((b) => b.berth)],
  );
  for (const row of rows) out.set(`${row.td_area}|${row.berth_code}`, Number(row.allowance));
  return out;
}

/** TD areas with a feed gap open now (`null` in the set = a gap for every area). */
export async function loadOpenTdFeedGaps(db: Queryable, now: Date): Promise<Set<string | null>> {
  const { rows } = await db.query<{ td_area: string | null }>(
    `select distinct td_area from feed_gap
      where feed_name = 'TD'
        and coalesce(affected_time_start, detected_start) <= $1
        and (coalesce(affected_time_end, detected_end) is null
             or coalesce(affected_time_end, detected_end) >= $1 - interval '1 hour')`,
    [now],
  );
  return new Set(rows.map((row) => row.td_area));
}

/** For each description, every berth currently showing it and when that berth last changed. */
export async function loadCurrentBerthsForDescriptions(
  db: Queryable,
  descriptions: readonly string[],
): Promise<Map<string, Array<{ tdArea: string; berth: string; eventAt: Date }>>> {
  const out = new Map<string, Array<{ tdArea: string; berth: string; eventAt: Date }>>();
  if (descriptions.length === 0) return out;
  const { rows } = await db.query<{
    td_area: string;
    berth_code: string;
    description: string;
    event_at: Date;
  }>(
    `select td_area, berth_code, description, event_at from berth_current_state
      where projection_version = $1 and description = any($2::text[])`,
    [TD_PROJECTION_VERSION, [...descriptions]],
  );
  for (const row of rows) {
    const list = out.get(row.description) ?? [];
    list.push({ tdArea: row.td_area, berth: row.berth_code, eventAt: row.event_at });
    out.set(row.description, list);
  }
  return out;
}

/** Each run's estimate in force now (the newest row, unless it is `cleared`). */
export async function loadActiveEstimates(
  db: Queryable,
  runs: ReadonlyArray<{ trustId: string; activatedAt: Date }>,
): Promise<Map<string, RunEstimateState>> {
  const out = new Map<string, RunEstimateState>();
  if (runs.length === 0) return out;
  const { rows } = await db.query<{
    trust_id: string;
    band: string;
    minutes_late: number | null;
    basis: "timing_point" | "held_in_berth" | null;
    effective_at: Date;
  }>(
    `select p.trust_id, e.band, e.minutes_late, e.basis, e.effective_at
       from unnest($1::text[], $2::timestamptz[]) as p(trust_id, activated_at)
       cross join lateral (
         select e.band, e.minutes_late, e.basis, e.effective_at
           from estimated_delay_band_change e
          where e.trust_id = p.trust_id and ${withinTrustRun("e.effective_at", "p.activated_at")}
          order by e.effective_at desc, e.id desc limit 1
       ) e
      where e.band <> 'cleared'`,
    [runs.map((r) => r.trustId), runs.map((r) => r.activatedAt)],
  );
  for (const row of rows) {
    out.set(row.trust_id, {
      band: row.band as RunEstimateState["band"],
      minutesLate: row.minutes_late ?? 0,
      basis: row.basis ?? "held_in_berth",
      lastEstimatedAt: row.effective_at,
    });
  }
  return out;
}

export interface EstimateChangeRow {
  trustId: string;
  activatedAt: Date;
  band: RunEstimateState["band"] | "cleared";
  minutesLate: number | null;
  basis: RunEstimateState["basis"] | null;
  clearReason: string | null;
  tdArea: string;
  berth: string;
  occupancyId: string;
  occupancyEnteredAt: Date;
  effectiveAt: Date;
}

export async function recordEstimateChanges(
  db: Queryable,
  changes: readonly EstimateChangeRow[],
  /** Milestone 97d: 'backfill' for a replay (migration 0055). */
  source: "live" | "backfill" = "live",
): Promise<number> {
  if (changes.length === 0) return 0;
  const result = await db.query(
    `insert into estimated_delay_band_change (
       trust_id, activated_at, band, minutes_late, basis, clear_reason, td_area, berth_code,
       berth_occupancy_id, occupancy_entered_at, effective_at, source
     )
     select *, $12::text from unnest(
       $1::text[], $2::timestamptz[], $3::text[], $4::integer[], $5::text[], $6::text[],
       $7::text[], $8::text[], $9::bigint[], $10::timestamptz[], $11::timestamptz[]
     )
     returning id`,
    [
      changes.map((c) => c.trustId),
      changes.map((c) => c.activatedAt),
      changes.map((c) => c.band),
      changes.map((c) => c.minutesLate),
      changes.map((c) => c.basis),
      changes.map((c) => c.clearReason),
      changes.map((c) => c.tdArea),
      changes.map((c) => c.berth),
      changes.map((c) => c.occupancyId),
      changes.map((c) => c.occupancyEnteredAt),
      changes.map((c) => c.effectiveAt),
      source,
    ],
  );
  return result.rows.length;
}

export interface HeldDelayContext {
  now: Date;
  trust: RunTrustState | undefined;
  locations: readonly ScheduleLocationRow[];
  tiplocStanox: ReadonlyMap<string, string>;
  berthStanoxes: readonly string[];
  berthAllowanceMinutes: number | undefined;
  feedGapAreas: ReadonlySet<string | null>;
  sameDescriptionBerths: ReadonlyArray<{ tdArea: string; berth: string; eventAt: Date }>;
}

/**
 * Milestone 97b (docs/adr/0021): turns one held-train candidate and the data read for it into
 * `estimateHeldDelay`'s input. Pure, so the schedule-position rules are unit-tested.
 *
 *  - The berth's location in the schedule is the first visit to one of its SMART STANOXes at or
 *    after the last TRUST report's location (strictly after it if that report was a departure or
 *    pass from there: that visit is done).
 *  - Allowances "still ahead" are those recorded at the last reported location and at every
 *    later location before the next one with a STANOX (where TRUST would report next). An
 *    allowance belongs to the section after its timing point (measured, ADR 0021 "Evidence").
 */
export function buildHeldDelayInput(
  candidate: HeldTrainCandidate,
  ctx: HeldDelayContext,
): HeldDelayInput {
  const stanoxOf = (tiploc: string) => ctx.tiplocStanox.get(tiploc) ?? null;
  const berthStanoxes = new Set(ctx.berthStanoxes);
  const raw = ctx.trust?.latestReport ?? null;

  let lastReport: HeldDelayInput["lastReport"] = null;
  let lastReportSeq: number | null = null;
  let leftReportedLocation = false;
  if (raw) {
    const decoded = decodeTrustMovementFlags(raw.flags);
    const hasMinutes =
      typeof raw.timetableVariation === "number" && Number.isFinite(raw.timetableVariation);
    const minutesLate =
      !hasMinutes && (decoded.variation === "late" || decoded.variation === "early")
        ? null
        : decoded.variation === "off_route"
          ? null
          : signedVariationMinutes(raw.timetableVariation, decoded.variation);
    lastReport = {
      minutesLate,
      actualAt: raw.actualAt,
      kind: decoded.eventKind,
      terminated: decoded.terminated,
      atThisBerthLocation: raw.locStanox !== null && berthStanoxes.has(raw.locStanox),
    };
    const reported = ctx.locations.filter(
      (loc) => raw.locStanox !== null && stanoxOf(loc.tiploc) === raw.locStanox,
    );
    lastReportSeq = reported.length > 0 ? Math.min(...reported.map((loc) => loc.seqNo)) : null;
    leftReportedLocation = decoded.eventKind === "departure";
  }

  const berthLocation =
    ctx.locations.find((loc) => {
      const stanox = stanoxOf(loc.tiploc);
      if (stanox === null || !berthStanoxes.has(stanox)) return false;
      if (lastReportSeq === null) return true;
      return leftReportedLocation ? loc.seqNo > lastReportSeq : loc.seqNo >= lastReportSeq;
    }) ?? null;

  let timingPoint: HeldDelayInput["timingPoint"] = null;
  const atDestination = berthLocation?.recordIdentity === "LT";
  if (berthLocation && !atDestination) {
    const kind = berthLocation.departure ? "departure" : berthLocation.pass ? "pass" : null;
    const time = parseCifTimeToMinutes(berthLocation.departure ?? berthLocation.pass);
    if (kind && time !== null) {
      const originDeparture = parseCifTimeToMinutes(ctx.locations[0]?.departure ?? null);
      timingPoint = {
        kind,
        atOrigin: berthLocation.recordIdentity === "LO",
        bookedAt: londonWallClockToInstant(
          candidate.trafficDay,
          time,
          scheduleDayOffset(time, originDeparture, berthLocation.nextDay),
        ),
      };
    }
  }

  let allowancesAheadMinutes = 0;
  if (lastReportSeq !== null) {
    for (const loc of ctx.locations) {
      if (loc.seqNo < lastReportSeq) continue;
      if (loc.seqNo > lastReportSeq && stanoxOf(loc.tiploc) !== null) break;
      allowancesAheadMinutes +=
        parseCifAllowanceMinutes(loc.engineeringAllowance) +
        parseCifAllowanceMinutes(loc.pathingAllowance) +
        parseCifAllowanceMinutes(loc.performanceAllowance);
    }
  }

  const cancellation = ctx.trust?.latestCancellation ?? null;
  return {
    now: ctx.now,
    occupancyEnteredAt: candidate.enteredAt,
    lastReport,
    timingPoint,
    atDestination,
    berthAllowanceMinutes: ctx.berthAllowanceMinutes ?? BERTH_ALLOWANCE_DEFAULT_MINUTES,
    allowancesAheadMinutes,
    cancelled: cancellation !== null && cancellation.reinstate === 0,
    feedGap: ctx.feedGapAreas.has(null) || ctx.feedGapAreas.has(candidate.tdArea),
    seenElsewhere: ctx.sameDescriptionBerths.some(
      (other) =>
        !(other.tdArea === candidate.tdArea && other.berth === candidate.berth) &&
        other.eventAt.getTime() > candidate.enteredAt.getTime(),
    ),
  };
}

/**
 * Milestone 97c (docs/adr/0021): the estimate for one train, worked out now — for the popup, so
 * its minutes are current rather than frozen at the sweep's last band change. Same inputs and
 * rule as `ingest-garner`'s sweep, read directly (no caches).
 */
export async function computeHeldDelayEstimate(
  db: Queryable,
  candidate: HeldTrainCandidate,
  now: Date,
): Promise<{ input: HeldDelayInput; result: HeldDelayResult }> {
  const berthKey = `${candidate.tdArea}|${candidate.berth}`;
  const berthRef = [{ tdArea: candidate.tdArea, berth: candidate.berth }];
  const [trust, schedules, berthStanoxes, allowances, feedGapAreas, sameDescription] =
    await Promise.all([
      loadRunTrustStates(db, [candidate]),
      loadScheduleLocations(db, [candidate.cifScheduleId]),
      loadBerthStanoxes(db, berthRef),
      loadBerthAllowances(db, berthRef),
      loadOpenTdFeedGaps(db, now),
      loadCurrentBerthsForDescriptions(db, [candidate.description]),
    ]);
  const locations = schedules.get(candidate.cifScheduleId) ?? [];
  const tiplocStanox = await loadTiplocStanoxes(db, [...new Set(locations.map((l) => l.tiploc))]);
  const input = buildHeldDelayInput(candidate, {
    now,
    trust: trust.get(candidate.trustId),
    locations,
    tiplocStanox,
    berthStanoxes: berthStanoxes.get(berthKey) ?? [],
    berthAllowanceMinutes: allowances.get(berthKey),
    feedGapAreas,
    sameDescriptionBerths: sameDescription.get(candidate.description) ?? [],
  });
  return { input, result: estimateHeldDelay(input) };
}

/** The estimate in force for a run at `at` (newest row at or before it, unless cleared). */
export async function findEstimateInForce(
  db: Queryable,
  run: { trustId: string; activatedAt: Date },
  at: Date,
): Promise<(RunEstimateState & { occupancyId: string }) | null> {
  const { rows } = await db.query<{
    band: string;
    minutes_late: number | null;
    basis: "timing_point" | "held_in_berth" | null;
    effective_at: Date;
    berth_occupancy_id: string;
  }>(
    `select band, minutes_late, basis, effective_at, berth_occupancy_id::text as berth_occupancy_id
       from estimated_delay_band_change e
      where e.trust_id = $1 and e.effective_at <= $3
        and ${withinTrustRun("e.effective_at", "$2::timestamptz")}
      order by e.effective_at desc, e.id desc limit 1`,
    [run.trustId, run.activatedAt, at],
  );
  const row = rows[0];
  if (!row || row.band === "cleared") return null;
  return {
    band: row.band as RunEstimateState["band"],
    minutesLate: row.minutes_late ?? 0,
    basis: row.basis ?? "held_in_berth",
    lastEstimatedAt: row.effective_at,
    occupancyId: row.berth_occupancy_id,
  };
}

// ---------------------------------------------------------------------------------------------
// Milestone 97d (docs/adr/0021): replaying the sweep over a past window (the estimate backfill).
// ---------------------------------------------------------------------------------------------

/** Same bound as `findMapDelaysAt`: an occupancy that started longer before `at` than this is
 * not looked for. */
const REPLAY_OCCUPANCY_LOOKBACK = "24 hours";

/**
 * `findHeldTrainCandidates` as it stood at `at`: each berth's occupancy covering that moment (the
 * latest to start at or before it, still open then), its run link, and the run's activation
 * known by then. Same query shape as `findMapDelaysAt`, which playback already uses.
 */
export async function findHeldTrainCandidatesAt(
  db: Queryable,
  berths: ReadonlyArray<{ tdArea: string; berth: string }>,
  at: Date,
): Promise<HeldTrainCandidate[]> {
  if (berths.length === 0) return [];
  const { rows } = await db.query<{
    td_area: string;
    berth_code: string;
    description: string;
    occupancy_id: string;
    entered_at: Date;
    run_key: string;
    match_confidence: "solid" | "weak";
    cif_schedule_id: string;
    traffic_day: string;
    trust_id: string;
    activated_at: Date;
  }>(
    `with wanted as (
       select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code
     ),
     occ as materialized (
       select w.td_area, w.berth_code, o.description, o.id, o.entered_at
       from wanted w
       cross join lateral (
         select o.id, o.entered_at, o.description, o.left_at from berth_occupancy o
         where o.projection_version = $3 and o.td_area = w.td_area and o.berth_code = w.berth_code
           and o.entered_at <= $4::timestamptz
           and o.entered_at > $4::timestamptz - $5::interval
         order by o.entered_at desc limit 1
       ) o
       where o.left_at is null or o.left_at > $4::timestamptz
     ),
     runs as materialized (
       select occ.*, r.id as run_id, r.cif_schedule_id, r.traffic_day, r.match_confidence
       from occ
       join berth_occupancy_run_link l
         on l.berth_occupancy_id = occ.id and l.occupancy_entered_at = occ.entered_at
       join train_run r on r.id = l.train_run_id
       where r.superseded_by is null and r.cif_schedule_id is not null
     )
     select runs.td_area, runs.berth_code, runs.description, runs.id::text as occupancy_id,
            runs.entered_at, runs.run_id::text as run_key, runs.match_confidence,
            runs.cif_schedule_id::text as cif_schedule_id, runs.traffic_day::text as traffic_day,
            a.trust_id, a.created as activated_at
     from runs
     cross join lateral (
       select ta.trust_id, ta.created from trust_activation ta
       where ta.cif_schedule_id = runs.cif_schedule_id
         and ta.created >= (runs.traffic_day)::timestamp at time zone 'Europe/London'
         and ta.created <= $4::timestamptz
       order by ta.created desc limit 1
     ) a`,
    [
      berths.map((b) => b.tdArea),
      berths.map((b) => b.berth),
      TD_PROJECTION_VERSION,
      at,
      REPLAY_OCCUPANCY_LOOKBACK,
    ],
  );
  return rows.map((row) => ({
    tdArea: row.td_area,
    berth: row.berth_code,
    description: row.description,
    occupancyId: row.occupancy_id,
    enteredAt: row.entered_at,
    runKey: row.run_key,
    matchConfidence: row.match_confidence,
    cifScheduleId: row.cif_schedule_id,
    trafficDay: row.traffic_day,
    trustId: row.trust_id,
    activatedAt: row.activated_at,
  }));
}

/** `loadCurrentBerthsForDescriptions` as it stood at `at`: every berth occupied by each
 * description then, with when that occupancy began. Uses the `(description, entered_at)` index. */
export async function loadOccupiedBerthsForDescriptionsAt(
  db: Queryable,
  descriptions: readonly string[],
  at: Date,
): Promise<Map<string, Array<{ tdArea: string; berth: string; eventAt: Date }>>> {
  const out = new Map<string, Array<{ tdArea: string; berth: string; eventAt: Date }>>();
  if (descriptions.length === 0) return out;
  const { rows } = await db.query<{
    td_area: string;
    berth_code: string;
    description: string;
    entered_at: Date;
  }>(
    `select td_area, berth_code, description, entered_at from berth_occupancy
      where projection_version = $1 and description = any($2::text[])
        and entered_at <= $3::timestamptz and entered_at > $3::timestamptz - $4::interval
        and (left_at is null or left_at > $3::timestamptz)`,
    [TD_PROJECTION_VERSION, [...descriptions], at, REPLAY_OCCUPANCY_LOOKBACK],
  );
  for (const row of rows) {
    const list = out.get(row.description) ?? [];
    list.push({ tdArea: row.td_area, berth: row.berth_code, eventAt: row.entered_at });
    out.set(row.description, list);
  }
  return out;
}

/** How many live (not backfilled) estimate rows fall in `[from, to)`: a backfill refuses to run
 * over live history. */
export async function countLiveEstimatesIn(db: Queryable, from: Date, to: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from estimated_delay_band_change
      where source = 'live' and effective_at >= $1 and effective_at < $2`,
    [from, to],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Removes an earlier backfill's rows in `[from, to]` so a re-run replaces rather than
 * duplicates them. Only ever `source = 'backfill'` rows — derived, and rebuilt by the same job.
 * Inclusive of `to`: a backfill's closing clears are stamped exactly at its end. */
export async function deleteBackfilledEstimatesIn(
  db: Queryable,
  from: Date,
  to: Date,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `delete from estimated_delay_band_change
      where source = 'backfill' and effective_at >= $1 and effective_at <= $2
      returning id`,
    [from, to],
  );
  return rows.length;
}
