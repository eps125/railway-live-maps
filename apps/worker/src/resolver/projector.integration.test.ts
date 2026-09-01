import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPool,
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import {
  runProjectResolver,
  seedFreshResolverCheckpoint,
  RESOLVER_PROJECTION_NAME,
} from "./projector.js";
import { advisoryLockKey } from "../shared/advisoryLock.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}
function uniqueSignallingId(): string {
  // 4-char, uppercase letters+digits — same shape as a real headcode.
  return randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
}
function uniqueTiploc(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

async function seedOccupancy(
  tdArea: string,
  berth: string,
  description: string,
  enteredAt: Date,
  leftAt: Date | null,
): Promise<string> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveResult.rows[0]!.id],
  );
  const eventResult = await pool.query<{ id: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id`,
    [frameResult.rows[0]!.id, tdArea, enteredAt, randomUUID()],
  );
  const occupancyResult = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, $6, $7, $5, 'cc_interpose')
     returning id`,
    [TD_PROJECTION_VERSION, tdArea, berth, description, enteredAt, leftAt, eventResult.rows[0]!.id],
  );
  return occupancyResult.rows[0]!.id;
}

async function seedTrainRun(
  signallingId: string,
  serviceDate: string,
  activatedAt: Date | null,
  scheduleId: string | null,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into train_run (
       trust_train_id, signalling_id, service_date, schedule_id, activated_at, last_event_at
     ) values ($1, $2, $3, $4, $5, now())
     returning id`,
    [
      `T${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      signallingId,
      serviceDate,
      scheduleId,
      activatedAt,
    ],
  );
  return result.rows[0]!.id;
}

async function seedRunScheduleLink(
  trainRunId: string,
  matchOutcome: string,
  scheduleId: string | null,
): Promise<void> {
  await pool.query(
    `insert into run_schedule_link (train_run_id, activation_at, schedule_id, match_outcome)
     values ($1, now(), $2, $3)`,
    [trainRunId, scheduleId, matchOutcome],
  );
}

async function seedSchedule(): Promise<string> {
  // source: 'VSTP', not 'SCHEDULE' — apps/worker/src/schedule/scheduleImporter.ts's full-file
  // swap unconditionally deletes every source='SCHEDULE' row (and these test rows/train_run
  // links outlive this test, same as every other integration test's fixtures in this shared
  // database), which would otherwise collide with train_run's FK into schedule.
  const result = await pool.query<{ id: string }>(
    `insert into schedule (
       train_uid, schedule_start_date, schedule_end_date, stp_indicator, source, raw_source_json
     ) values ($1, '2026-01-01', '2026-12-31', 'P', 'VSTP', '{}')
     returning id`,
    [`U${randomUUID().replace(/-/g, "").slice(0, 5)}`],
  );
  return result.rows[0]!.id;
}

async function seedScheduleLocation(scheduleId: string, stanox: string): Promise<void> {
  await pool.query(
    `insert into schedule_location (schedule_id, seq_no, location_type, tiploc, stanox)
     values ($1, 1, 'intermediate', 'TESTLOC', $2)`,
    [scheduleId, stanox],
  );
}

/** No `stanox` — this is the real shape of every VSTP-sourced schedule_location row (VSTP's
 * wire format only ever carries tiploc, confirmed 2026-08-10), which is what
 * seedLocationReference()'s CORPUS-derived bridge exists to compensate for. */
async function seedScheduleLocationTiplocOnly(scheduleId: string, tiploc: string): Promise<void> {
  await pool.query(
    `insert into schedule_location (schedule_id, seq_no, location_type, tiploc, stanox)
     values ($1, 1, 'intermediate', $2, null)`,
    [scheduleId, tiploc],
  );
}

async function seedLocationReference(tiploc: string, stanox: string): Promise<void> {
  await pool.query(
    `insert into location_reference (tiploc, stanox, raw_source_json) values ($1, $2, '{}')`,
    [tiploc, stanox],
  );
}

async function seedSmartBerthStep(tdArea: string, toBerth: string, stanox: string): Promise<void> {
  await pool.query(
    `insert into smart_berth_step (td_area, to_berth, stanox, raw_source_json)
     values ($1, $2, $3, '{}')`,
    [tdArea, toBerth, stanox],
  );
}

/** A single TRUST movement `train_run_event` for `trainRunId` reporting `locStanox` at `eventAt`
 * — the raw material for the resolver's movement-correlation (#3b) signal. Creates the backing
 * raw_archive_object/feed_frame/raw_feed_event lineage the composite FK requires, same pattern as
 * seedOccupancy(). */
async function seedMovementEvent(
  trainRunId: string,
  locStanox: string,
  eventAt: Date,
): Promise<void> {
  const body = JSON.stringify({ body: { loc_stanox: locStanox } });
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TRUST', '/topic/TRAIN_MVT_ALL_TOC', now(), $1, $2) returning id`,
    [randomUUID(), archiveResult.rows[0]!.id],
  );
  const rawEvent = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TRUST', 'movement', null, $2, $3, $3, $4, 'parsed', 1)
     returning id, ingestion_sequence`,
    [frameResult.rows[0]!.id, body, eventAt, randomUUID()],
  );
  await pool.query(
    `insert into train_run_event (
       train_run_id, raw_event_id, raw_event_normalized_at_utc, trust_message_type, event_at,
       ingestion_sequence, normalization_version, raw_event_json
     ) values ($1, $2, $3, 'movement', $3, $4, 1, $5)`,
    [trainRunId, rawEvent.rows[0]!.id, eventAt, rawEvent.rows[0]!.ingestion_sequence, body],
  );
}

async function resolution(occupancyId: string): Promise<
  | {
      status: string;
      selected_train_run_id: string | null;
      decided_at: Date;
    }
  | undefined
> {
  const result = await pool.query(
    `select status, selected_train_run_id, decided_at from berth_run_resolution where occupancy_id = $1`,
    [occupancyId],
  );
  return result.rows[0];
}

// 2026-08-10 is a Monday, well inside the fixed schedule window seedSchedule() uses.
const SERVICE_DATE = "2026-08-10";
const ENTERED_AT = new Date("2026-08-10T10:00:00.000Z");
const ACTIVATED_AT = new Date("2026-08-10T09:30:00.000Z");

describe("runProjectResolver (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("matches a single strong candidate (schedule-linked + temporally plausible + SMART match)", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const occupancyId = await seedOccupancy(area, "0001", signallingId, ENTERED_AT, null);

    const scheduleId = await seedSchedule();
    await seedScheduleLocation(scheduleId, "12345");
    await seedSmartBerthStep(area, "0001", "12345");
    const runId = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleId);
    await seedRunScheduleLink(runId, "matched", scheduleId);

    await runProjectResolver(pool);

    const row = await resolution(occupancyId);
    expect(row).toMatchObject({ status: "matched", selected_train_run_id: runId });
  });

  it("bridges SMART/STANOX evidence via CORPUS's tiploc when the schedule's own location has no stanox (the real shape of every VSTP-sourced schedule)", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const tiploc = uniqueTiploc();
    const occupancyId = await seedOccupancy(area, "0006", signallingId, ENTERED_AT, null);

    const scheduleId = await seedSchedule();
    await seedScheduleLocationTiplocOnly(scheduleId, tiploc);
    await seedLocationReference(tiploc, "67890");
    await seedSmartBerthStep(area, "0006", "67890");
    const runId = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleId);
    await seedRunScheduleLink(runId, "matched", scheduleId);

    await runProjectResolver(pool);

    const row = await resolution(occupancyId);
    expect(row).toMatchObject({ status: "matched", selected_train_run_id: runId });
  });

  it("two equally-plausible candidates resolve as ambiguous, never silently picked", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const occupancyId = await seedOccupancy(area, "0002", signallingId, ENTERED_AT, null);

    const runA = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, null);
    const runB = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, null);

    await runProjectResolver(pool);

    const row = await resolution(occupancyId);
    expect(row?.status).toBe("ambiguous");
    expect(row?.selected_train_run_id).toBeNull();
    void runA;
    void runB;
  });

  it("movement-report correlation breaks a schedule + temporal + SMART tie toward the run reporting past this berth", async () => {
    // The real 2C84 case: two genuine same-day workings of one headcode tie on every coarse
    // signal — both schedule-linked, both inside the 24h temporal window, both SMART-correlated
    // because both routes call at the berth's STANOX — with no preceding matched occupancy to
    // chain continuity from. Only one is actually reporting TRUST movements past this berth now.
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const occupancyId = await seedOccupancy(area, "0700", signallingId, ENTERED_AT, null);
    await seedSmartBerthStep(area, "0700", "70001");

    const scheduleHere = await seedSchedule();
    await seedScheduleLocation(scheduleHere, "70001");
    const runHere = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleHere);
    await seedRunScheduleLink(runHere, "matched", scheduleHere);

    const scheduleElsewhere = await seedSchedule();
    await seedScheduleLocation(scheduleElsewhere, "70001");
    const runElsewhere = await seedTrainRun(
      signallingId,
      SERVICE_DATE,
      ACTIVATED_AT,
      scheduleElsewhere,
    );
    await seedRunScheduleLink(runElsewhere, "matched", scheduleElsewhere);

    // runHere reports the berth's STANOX 30s after the step; runElsewhere is reporting a
    // completely different STANOX at the same moment.
    await seedMovementEvent(runHere, "70001", new Date(ENTERED_AT.getTime() + 30_000));
    await seedMovementEvent(runElsewhere, "88888", new Date(ENTERED_AT.getTime() + 30_000));

    await runProjectResolver(pool);

    expect(await resolution(occupancyId)).toMatchObject({
      status: "matched",
      selected_train_run_id: runHere,
    });
  });

  it("a movement report outside the correlation window does not break the tie", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const occupancyId = await seedOccupancy(area, "0702", signallingId, ENTERED_AT, null);
    await seedSmartBerthStep(area, "0702", "72001");

    const scheduleA = await seedSchedule();
    await seedScheduleLocation(scheduleA, "72001");
    const runA = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleA);
    await seedRunScheduleLink(runA, "matched", scheduleA);

    const scheduleB = await seedSchedule();
    await seedScheduleLocation(scheduleB, "72001");
    const runB = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleB);
    await seedRunScheduleLink(runB, "matched", scheduleB);

    // runA did report this STANOX, but ~20 minutes before the train stepped into the berth — a
    // different pass entirely (or an earlier working), not this occupancy.
    await seedMovementEvent(runA, "72001", new Date(ENTERED_AT.getTime() - 20 * 60_000));

    await runProjectResolver(pool);

    expect((await resolution(occupancyId))?.status).toBe("ambiguous");
    void runB;
  });

  it("temporal grace: a run whose TRUST activation lags the TD headcode by under the grace window still scores temporal plausibility", async () => {
    // Real 2026-08-31 case (berth PX 0251 / 5C70): the correct run activated ~7.5 min *after* the
    // berth step, so under a hard `entered_at >= activated_at` it lost the temporal score to
    // unrelated same-headcode workings that activated earlier the same day.
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const occupancyId = await seedOccupancy(area, "0C01", signallingId, ENTERED_AT, null);

    const scheduleLagged = await seedSchedule();
    const laggedRun = await seedTrainRun(
      signallingId,
      SERVICE_DATE,
      new Date(ENTERED_AT.getTime() + 12 * 60_000), // activated 12 min AFTER the step — inside grace
      scheduleLagged,
    );
    await seedRunScheduleLink(laggedRun, "matched", scheduleLagged);

    // A same-headcode run that activated 25h earlier — outside MAX_JOURNEY_MS, so no temporal
    // score either way; only the schedule link (40). Without grace, laggedRun also scores only 40
    // → tie → ambiguous. With grace, laggedRun scores 40 + 35 and wins outright.
    const scheduleStale = await seedSchedule();
    const staleRun = await seedTrainRun(
      signallingId,
      SERVICE_DATE,
      new Date(ENTERED_AT.getTime() - 25 * 60 * 60_000),
      scheduleStale,
    );
    await seedRunScheduleLink(staleRun, "matched", scheduleStale);

    await runProjectResolver(pool);

    expect(await resolution(occupancyId)).toMatchObject({
      status: "matched",
      selected_train_run_id: laggedRun,
    });
  });

  it("temporal grace: an activation later than the grace window gets no temporal score", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const occupancyId = await seedOccupancy(area, "0C02", signallingId, ENTERED_AT, null);

    const scheduleLate = await seedSchedule();
    const wayLateRun = await seedTrainRun(
      signallingId,
      SERVICE_DATE,
      new Date(ENTERED_AT.getTime() + 45 * 60_000), // 45 min after the step — beyond the 20-min grace
      scheduleLate,
    );
    await seedRunScheduleLink(wayLateRun, "matched", scheduleLate);

    const scheduleOther = await seedSchedule();
    const otherRun = await seedTrainRun(
      signallingId,
      SERVICE_DATE,
      new Date(ENTERED_AT.getTime() - 25 * 60 * 60_000),
      scheduleOther,
    );
    await seedRunScheduleLink(otherRun, "matched", scheduleOther);

    await runProjectResolver(pool);

    // both score the schedule link (40) only → honest tie.
    expect((await resolution(occupancyId))?.status).toBe("ambiguous");
    void otherRun;
  });

  it("seedFreshResolverCheckpoint jumps a never-advanced checkpoint past pre-window occupancies, then no-ops", async () => {
    const area = uniqueArea();
    // freshly inserted, so both get current (top-of-sequence) ids regardless of entered_at
    const oldOccupancyId = await seedOccupancy(
      area,
      "0A01",
      uniqueSignallingId(),
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      null,
    );
    const recentOccupancyId = await seedOccupancy(
      area,
      "0A02",
      uniqueSignallingId(),
      new Date(Date.now() - 30 * 60 * 1000),
      null,
    );

    const defId = await getOrCreateProjectionDefinition(pool, `test-seed-${randomUUID()}`, 1, "h");
    await ensureCheckpoint(pool, defId);

    const windowCutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const seededTo = await seedFreshResolverCheckpoint(pool, defId, windowCutoff);

    // seeded exactly to the highest pre-window occupancy id — the forward scan would now skip it
    // but still pick up the in-window one.
    expect(seededTo).toBe(oldOccupancyId);
    expect(BigInt(seededTo!)).toBeLessThan(BigInt(recentOccupancyId));

    // idempotent: once the checkpoint has advanced, it never re-seeds
    await advanceCheckpoint(pool, defId, seededTo!);
    expect(await seedFreshResolverCheckpoint(pool, defId, windowCutoff)).toBeNull();

    // no-op when there is no pre-window history at all
    const defId2 = await getOrCreateProjectionDefinition(pool, `test-seed-${randomUUID()}`, 1, "h");
    await ensureCheckpoint(pool, defId2);
    expect(
      await seedFreshResolverCheckpoint(pool, defId2, new Date("2000-01-01T00:00:00Z")),
    ).toBeNull();
    expect((await getCheckpoint(pool, defId2))?.lastIngestionSequence).toBe("0");
  });

  it("no candidates at all resolves as unmatched", async () => {
    const area = uniqueArea();
    const occupancyId = await seedOccupancy(area, "0003", uniqueSignallingId(), ENTERED_AT, null);

    await runProjectResolver(pool);

    const row = await resolution(occupancyId);
    expect(row).toMatchObject({ status: "unmatched", selected_train_run_id: null });
  });

  it("the live window skips occupancies older than it; --backfill --since resolves them without touching the live checkpoint", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    // ENTERED_AT is many days before real wall-clock `now()`, so a 72h live window excludes it.
    const occupancyId = await seedOccupancy(area, "0800", signallingId, ENTERED_AT, null);

    const scheduleId = await seedSchedule();
    await seedScheduleLocation(scheduleId, "80001");
    await seedSmartBerthStep(area, "0800", "80001");
    const runId = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleId);
    await seedRunScheduleLink(runId, "matched", scheduleId);

    // Windowed live loop: the stale occupancy is never picked up.
    await runProjectResolver(pool, { liveWindowMs: 72 * 60 * 60 * 1000 });
    expect(await resolution(occupancyId)).toBeUndefined();

    // Backfill from before it — re-run until drained, mirroring how an operator runs it.
    const since = new Date(ENTERED_AT.getTime() - 60_000);
    let guard = 0;
    let summary = await runProjectResolver(pool, { backfillSince: since });
    while (summary.moreBacklogRemains && guard++ < 50) {
      summary = await runProjectResolver(pool, { backfillSince: since });
    }

    expect(await resolution(occupancyId)).toMatchObject({
      status: "matched",
      selected_train_run_id: runId,
    });

    // Backfilled rows are stamped at the current resolver version, so a further backfill pass
    // over the same range doesn't re-decide this one.
    const before = await resolution(occupancyId);
    await runProjectResolver(pool, { backfillSince: since });
    const after = await resolution(occupancyId);
    expect(after?.decided_at).toEqual(before?.decided_at);
  });

  it("re-running is idempotent — the checkpoint advances and the row is updated in place, not duplicated", async () => {
    const area = uniqueArea();
    const occupancyId = await seedOccupancy(area, "0004", uniqueSignallingId(), ENTERED_AT, null);

    await runProjectResolver(pool);
    const first = await resolution(occupancyId);
    await runProjectResolver(pool);
    const second = await resolution(occupancyId);

    expect(first?.status).toBe("unmatched");
    expect(second?.status).toBe("unmatched");
    const count = await pool.query(
      `select count(*)::int as n from berth_run_resolution where occupancy_id = $1`,
      [occupancyId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("an open occupancy's unmatched result is retried and flips to matched once a candidate later appears", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    // left_at: null — still open, eligible for the retry pass.
    const occupancyId = await seedOccupancy(area, "0005", signallingId, ENTERED_AT, null);

    await runProjectResolver(pool);
    expect((await resolution(occupancyId))?.status).toBe("unmatched");

    // Simulate the retry window having elapsed without waiting for it in real time.
    await pool.query(
      `update berth_run_resolution set decided_at = now() - interval '10 minutes' where occupancy_id = $1`,
      [occupancyId],
    );

    const scheduleId = await seedSchedule();
    const runId = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleId);
    await seedRunScheduleLink(runId, "matched", scheduleId);

    await runProjectResolver(pool);

    const row = await resolution(occupancyId);
    expect(row).toMatchObject({ status: "matched", selected_train_run_id: runId });
  });

  it("resolves many distinct occupancies correctly in one batched run without cross-contaminating candidates", async () => {
    // Regression test for a real production incident: the original implementation issued up to
    // 4 sequential queries per occupancy, which effectively hung against the real nationwide
    // berth_occupancy backlog. The fix batches all reads for the whole batch into a handful of
    // queries (see fetchBatchCandidateData) — this test proves that batching doesn't leak one
    // occupancy's candidates into another's result just because they're fetched together.
    const areaA = uniqueArea();
    const areaB = uniqueArea();
    const signallingA = uniqueSignallingId();
    const signallingB = uniqueSignallingId();

    const occupancyA = await seedOccupancy(areaA, "0010", signallingA, ENTERED_AT, null);
    const occupancyB = await seedOccupancy(areaB, "0020", signallingB, ENTERED_AT, null);
    const occupancyC = await seedOccupancy(areaA, "0011", uniqueSignallingId(), ENTERED_AT, null);

    const scheduleA = await seedSchedule();
    await seedScheduleLocation(scheduleA, "55555");
    await seedSmartBerthStep(areaA, "0010", "55555");
    const runA = await seedTrainRun(signallingA, SERVICE_DATE, ACTIVATED_AT, scheduleA);
    await seedRunScheduleLink(runA, "matched", scheduleA);

    // areaB's candidate deliberately has no evidence at all beyond the bare signalling match
    // (no activated_at means temporal plausibility can't apply either, per resolveBerthRun.ts).
    await seedTrainRun(signallingB, SERVICE_DATE, null, null);

    await runProjectResolver(pool);

    expect(await resolution(occupancyA)).toMatchObject({
      status: "matched",
      selected_train_run_id: runA,
    });
    expect((await resolution(occupancyB))?.status).toBe("unmatched");
    expect((await resolution(occupancyC))?.status).toBe("unmatched");
  });

  it("continuity from a preceding matched occupancy chain-heals a run of ties for the same description (real-world flap regression)", async () => {
    // Regression for a real production incident: a headcode shared by two genuine same-day
    // services ties on schedule-linked + temporally-plausible evidence whenever SMART coverage
    // is absent for a particular berth — without continuity evidence, a train confidently matched
    // one step flips to ambiguous on the very next step (and stays that way indefinitely) even
    // though nothing about it actually changed. Three consecutive berths, only the first has
    // SMART coverage — the other two must self-heal via continuity, and the third must chain
    // through the *second's* continuity-derived match, not just the first's SMART-derived one.
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const enteredAt1 = ENTERED_AT;
    const enteredAt2 = new Date(ENTERED_AT.getTime() + 60_000);
    const enteredAt3 = new Date(ENTERED_AT.getTime() + 120_000);

    const occupancy1 = await seedOccupancy(area, "0100", signallingId, enteredAt1, enteredAt2);
    const occupancy2 = await seedOccupancy(area, "0102", signallingId, enteredAt2, enteredAt3);
    const occupancy3 = await seedOccupancy(area, "0104", signallingId, enteredAt3, null);

    const scheduleA = await seedSchedule();
    await seedScheduleLocation(scheduleA, "99001");
    await seedSmartBerthStep(area, "0100", "99001"); // only berth 0100 has SMART coverage
    const runA = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleA);
    await seedRunScheduleLink(runA, "matched", scheduleA);

    const scheduleB = await seedSchedule();
    const runB = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleB);
    await seedRunScheduleLink(runB, "matched", scheduleB);

    await runProjectResolver(pool);

    expect(await resolution(occupancy1)).toMatchObject({
      status: "matched",
      selected_train_run_id: runA,
    });
    expect(await resolution(occupancy2)).toMatchObject({
      status: "matched",
      selected_train_run_id: runA,
    });
    expect(await resolution(occupancy3)).toMatchObject({
      status: "matched",
      selected_train_run_id: runA,
    });
    void runB;
  });

  it("continuity never applies across a gap wider than the lookback window", async () => {
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const enteredAt1 = ENTERED_AT;
    const enteredAt2 = new Date(ENTERED_AT.getTime() + 11 * 60_000); // just past the 10-minute window

    const occupancy1 = await seedOccupancy(area, "0110", signallingId, enteredAt1, enteredAt2);
    const occupancy2 = await seedOccupancy(area, "0112", signallingId, enteredAt2, null);

    const scheduleA = await seedSchedule();
    await seedScheduleLocation(scheduleA, "99002");
    await seedSmartBerthStep(area, "0110", "99002");
    const runA = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleA);
    await seedRunScheduleLink(runA, "matched", scheduleA);

    const scheduleB = await seedSchedule();
    const runB = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleB);
    await seedRunScheduleLink(runB, "matched", scheduleB);

    await runProjectResolver(pool);

    expect(await resolution(occupancy1)).toMatchObject({
      status: "matched",
      selected_train_run_id: runA,
    });
    // Outside the window: back to a genuine, honestly-reported tie.
    expect((await resolution(occupancy2))?.status).toBe("ambiguous");
    void runB;
  });

  it("continuity does not leak from one TD area into a same-description occupancy in a different area", async () => {
    // Regression for a real production incident (2026-08-11): a headcode reused nationwide fed
    // one area's continuity match into a completely unrelated area's occupancy of the same
    // description, well within the lookback window but nowhere near the same physical location.
    const areaA = uniqueArea();
    const areaB = uniqueArea();
    const signallingId = uniqueSignallingId();
    const enteredAt1 = ENTERED_AT;
    const enteredAt2 = new Date(ENTERED_AT.getTime() + 60_000);

    const occupancyA = await seedOccupancy(areaA, "0400", signallingId, enteredAt1, null);
    const scheduleA = await seedSchedule();
    await seedScheduleLocation(scheduleA, "99004");
    await seedSmartBerthStep(areaA, "0400", "99004");
    const runA = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleA);
    await seedRunScheduleLink(runA, "matched", scheduleA);

    const scheduleB = await seedSchedule();
    const runB = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleB);
    await seedRunScheduleLink(runB, "matched", scheduleB);

    const occupancyB = await seedOccupancy(areaB, "0500", signallingId, enteredAt2, null);

    await runProjectResolver(pool);

    expect(await resolution(occupancyA)).toMatchObject({
      status: "matched",
      selected_train_run_id: runA,
    });
    // Different area, no SMART coverage of its own: a genuine, honestly-reported tie, not an
    // accidental match inherited from area A.
    expect((await resolution(occupancyB))?.status).toBe("ambiguous");
  });

  it("continuity never lets a stale match win over a candidate with a more recent activation", async () => {
    // Regression for the same real incident: a TD headcode gets set on a stabled unit well
    // before TRUST fires the matching activation, so a genuinely different, freshly-activated
    // real train can appear *after* a stale continuity chain has already locked onto an earlier
    // one. The fresher activation must win the tie-break, not the older chain.
    const area = uniqueArea();
    const signallingId = uniqueSignallingId();
    const enteredAt1 = ENTERED_AT;
    const enteredAt2 = new Date(ENTERED_AT.getTime() + 60_000);

    const occupancy1 = await seedOccupancy(area, "0600", signallingId, enteredAt1, enteredAt2);
    const occupancy2 = await seedOccupancy(area, "0602", signallingId, enteredAt2, null);

    const staleActivatedAt = new Date(ACTIVATED_AT.getTime() - 60 * 60_000);
    const scheduleStale = await seedSchedule();
    await seedScheduleLocation(scheduleStale, "99005");
    await seedSmartBerthStep(area, "0600", "99005");
    const runStale = await seedTrainRun(
      signallingId,
      SERVICE_DATE,
      staleActivatedAt,
      scheduleStale,
    );
    await seedRunScheduleLink(runStale, "matched", scheduleStale);

    const scheduleFresh = await seedSchedule();
    const runFresh = await seedTrainRun(signallingId, SERVICE_DATE, ACTIVATED_AT, scheduleFresh);
    await seedRunScheduleLink(runFresh, "matched", scheduleFresh);

    await runProjectResolver(pool);

    // occupancy1: SMART breaks the tie toward the stale run — its own resolution is fine.
    expect(await resolution(occupancy1)).toMatchObject({
      status: "matched",
      selected_train_run_id: runStale,
    });
    // occupancy2: continuity would normally carry runStale forward, but runFresh's more recent
    // activation suppresses it — an honestly-reported tie, not a confidently-wrong stale match.
    expect((await resolution(occupancy2))?.status).toBe("ambiguous");
    void runFresh;
  });

  it("caps work per invocation and resumes the rest on the next call, reporting moreBacklogRemains", async () => {
    // Regression test for the real production incident: the very first run against an
    // already-large nationwide backlog needs to make bounded, visible progress per invocation
    // (so the Portainer projector loop's other commands aren't starved indefinitely) rather than
    // draining the entire backlog silently in one call.
    const area = uniqueArea();
    const occupancyIds = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        seedOccupancy(area, `010${i}`, uniqueSignallingId(), ENTERED_AT, null),
      ),
    );

    const first = await runProjectResolver(pool, { batchSize: 2, maxBatchesPerRun: 2 });
    expect(first.newlyResolved).toBe(4);
    expect(first.moreBacklogRemains).toBe(true);

    const resolvedAfterFirst = await Promise.all(occupancyIds.map((id) => resolution(id)));
    expect(resolvedAfterFirst.filter((row) => row !== undefined)).toHaveLength(4);

    const second = await runProjectResolver(pool, { batchSize: 2, maxBatchesPerRun: 2 });
    expect(second.newlyResolved).toBe(1);
    expect(second.moreBacklogRemains).toBe(false);

    const resolvedAfterSecond = await Promise.all(occupancyIds.map((id) => resolution(id)));
    expect(resolvedAfterSecond.every((row) => row !== undefined)).toBe(true);
  });

  it("skips instead of racing when another run already holds the self-exclusion advisory lock", async () => {
    // Regression test for a real production incident (2026-08-27): three concurrent connections
    // were observed all running this function's own batch-select query at once — a redeploy
    // doesn't guarantee the old container's process has fully exited before the new one's loop
    // starts, unlike this file's own `while true` shell loop, which only guarantees "one at a
    // time" within a single container's lifetime. This proves the fix (mirroring project-td's own
    // self-exclusion lock): a second concurrent invocation backs off cleanly instead of racing.
    const area = uniqueArea();
    const occupancyId = await seedOccupancy(area, "0901", uniqueSignallingId(), ENTERED_AT, null);

    const lockKey = advisoryLockKey(RESOLVER_PROJECTION_NAME);
    const lockHolder = await pool.connect();
    try {
      const acquired = await lockHolder.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1) as locked",
        [lockKey],
      );
      expect(acquired.rows[0]?.locked).toBe(true);

      const summary = await runProjectResolver(pool);
      expect(summary.skippedLockContention).toBe(true);
      expect(summary.newlyResolved).toBe(0);
      expect(await resolution(occupancyId)).toBeUndefined();
    } finally {
      await lockHolder.query("select pg_advisory_unlock($1)", [lockKey]);
      lockHolder.release();
    }

    // Once released, a normal run proceeds exactly as usual.
    const summary = await runProjectResolver(pool);
    expect(summary.skippedLockContention).toBe(false);
    expect((await resolution(occupancyId))?.status).toBe("unmatched");
  });
});
