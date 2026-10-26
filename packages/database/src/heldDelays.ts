import { TD_PROJECTION_VERSION, type RunEstimateState } from "@railway/domain";
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
          order by m.actual_timestamp desc, m.created desc limit 1
       ) m on true
       left join lateral (
         select max(m.created) as received_at from trust_movement m
          where m.trust_id = p.trust_id and ${withinTrustRun("m.created", "p.activated_at")}
       ) r on true
       left join lateral (
         select c.trust_id, c.type, c.reinstate from trust_cancellation c
          where c.trust_id = p.trust_id and ${withinTrustRun("c.created", "p.activated_at")}
          order by c.created desc limit 1
       ) c on true`,
    [runs.map((r) => r.trustId), runs.map((r) => r.activatedAt)],
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
): Promise<number> {
  if (changes.length === 0) return 0;
  const result = await db.query(
    `insert into estimated_delay_band_change (
       trust_id, activated_at, band, minutes_late, basis, clear_reason, td_area, berth_code,
       berth_occupancy_id, occupancy_entered_at, effective_at
     )
     select * from unnest(
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
    ],
  );
  return result.rows.length;
}
