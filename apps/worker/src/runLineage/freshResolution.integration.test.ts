import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, londonToday } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import {
  sweepFreshResolution,
  createFreshResolutionCooldown,
  runProjectRunLineage,
  type RunLineageSummary,
} from "./projector.js";

/**
 * docs/adr/0007 addendum (2026-09-14): proactive resolution for open, unlinked occupancies in
 * eligible TD areas. Separate file from projector.integration.test.ts (which covers the
 * pre-existing step-chain/boundary batch loop, untouched here) since this exercises a different
 * table shape (`map`/`map_version`/`map_binding_index`, real "now"-relative timestamps) rather
 * than that file's fixed-offset `td_berth_event` fixtures.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA_MAPPED = `F${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const AREA_UNMAPPED = `G${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const AREA_UPGRADE = `H${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const rawEventIds: string[] = [];
const scheduleIds: string[] = [];
const mapIds: string[] = [];
const locationReferenceTiplocs: string[] = [];
const smartBerthStepIds: string[] = [];

/** Recent-relative to real `Date.now()` — `sweepFreshResolution`'s own query bounds occupancies to
 * the last 15 minutes, so fixtures (unlike the fixed-2026-06-01 ones in projector.integration.test)
 * must be timestamped near actual test-run time. */
const T = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);

async function tdEvent(area: string, eventAt: Date): Promise<{ id: string; normalizedAt: Date }> {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archive.rows[0]!.id],
  );
  const ev = await pool.query<{ id: string; normalized_event_at_utc: Date }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, normalized_event_at_utc`,
    [frame.rows[0]!.id, area, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  return { id: row.id, normalizedAt: row.normalized_event_at_utc };
}

async function insertOpenOccupancy(params: {
  area: string;
  berth: string;
  description: string;
  enteredAt: Date;
  /** Defaults to a fresh `cc_interpose` (this test file's original, and still most common, case).
   * The step-chain-upgrade tests below pass `ca_step` + the step's own event instead, since that
   * occupancy's opening *is* the CA step already inserted into `td_berth_event`. */
  entryReason?: string;
  entryEvent?: { id: string; normalizedAt: Date };
}): Promise<{ id: string; enteredAt: Date }> {
  const entryEvent = params.entryEvent ?? (await tdEvent(params.area, params.enteredAt));
  const result = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, null, $6, $7, $8)
     returning id`,
    [
      TD_PROJECTION_VERSION,
      params.area,
      params.berth,
      params.description,
      params.enteredAt,
      entryEvent.id,
      entryEvent.normalizedAt,
      params.entryReason ?? "cc_interpose",
    ],
  );
  return { id: result.rows[0]!.id, enteredAt: params.enteredAt };
}

/** A `CA` (step) or `CB` (cancel) `td_berth_event` row — needed only for the step-chain-upgrade
 * tests below, since `runProjectRunLineage`'s batch loop (unlike `sweepFreshResolution`) reads
 * `td_berth_event` directly. `tdEvent` above deliberately doesn't insert one — nothing else in
 * this file needs it. */
async function tdBerthStepEvent(
  area: string,
  eventAt: Date,
  messageType: "CA" | "CB",
  fromBerth: string,
  toBerth: string | null,
  description: string,
): Promise<{ id: string; normalizedAt: Date }> {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archive.rows[0]!.id],
  );
  const ev = await pool.query<{
    id: string;
    normalized_event_at_utc: Date;
    ingestion_sequence: string;
  }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, 'C', $3, '{}', $4, $4, $5, 'parsed', 1)
     returning id, normalized_event_at_utc, ingestion_sequence`,
    [frame.rows[0]!.id, messageType, area, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
        from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, $4, $5, $6, $7, $2, $8, 1)`,
    [
      row.id,
      row.normalized_event_at_utc,
      area,
      messageType,
      fromBerth,
      toBerth,
      description,
      row.ingestion_sequence,
    ],
  );
  return { id: row.id, normalizedAt: row.normalized_event_at_utc };
}

async function insertLocationReference(
  tiploc: string,
  name: string,
  stanox: string,
): Promise<void> {
  await pool.query(
    `insert into location_reference (tiploc, name, stanox, raw_source_json) values ($1, $2, $3, '{}')`,
    [tiploc, name, stanox],
  );
  locationReferenceTiplocs.push(tiploc);
}

async function insertSmartBerthStep(tdArea: string, berth: string, stanox: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `insert into smart_berth_step (td_area, from_berth, to_berth, stanox, event_type, raw_source_json)
     values ($1, $2, $3, $4, 'A', '{}') returning id`,
    [tdArea, berth, `${berth}X`, stanox],
  );
  smartBerthStepIds.push(result.rows[0]!.id);
}

async function insertScheduleLocation(
  scheduleId: number,
  seqNo: number,
  tiploc: string,
): Promise<void> {
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code)
     values ($1, $2, 'LO', $3)`,
    [scheduleId, seqNo, tiploc],
  );
}

async function insertTrainRun(params: {
  cifScheduleId: string;
  cifTrainUid: string;
  // Must be the same "today" resolveFreshRunMatch will compute (londonToday(new Date())), not
  // the Postgres session's own current_date — the two can disagree right at a midnight BST
  // boundary, which would make the upgrade path's isSameRunIdentity check fail non-deterministically.
  trafficDay: string;
  matchBasis: string;
  matchConfidence: "solid" | "weak";
  establishedTdArea: string;
  establishedBerth: string;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into train_run (
       cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
       established_td_area, established_berth
     ) values ($1, $2, $3::date, $4, $5, $6, $7)
     returning id`,
    [
      params.cifScheduleId,
      params.cifTrainUid,
      params.trafficDay,
      params.matchBasis,
      params.matchConfidence,
      params.establishedTdArea,
      params.establishedBerth,
    ],
  );
  return result.rows[0]!.id;
}

async function insertRunLink(
  occupancy: { id: string; enteredAt: Date },
  trainRunId: string,
  linkBasis: string,
): Promise<void> {
  await pool.query(
    `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
     values ($1, $2, $3, $4)`,
    [occupancy.id, occupancy.enteredAt, trainRunId, linkBasis],
  );
}

let nextScheduleId = Date.now();

async function insertMinimalSchedule(cifTrainUid: string, signallingId: string): Promise<string> {
  const id = nextScheduleId++;
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid, signalling_id, runs_mo, runs_tu, runs_we,
       runs_th, runs_fr, runs_sa, runs_su, schedule_start_date, schedule_end_date
     ) values ($1, now(), 'P', $2, $3, true, true, true, true, true, true, true, '2026-01-01', '2026-12-31')`,
    [id, cifTrainUid, signallingId],
  );
  scheduleIds.push(String(id));
  return String(id);
}

/** A minimal published map binding one berth in `area` — enough for `getMappedTdAreas` to treat
 * the whole area as eligible (docs/adr/0007 addendum: one bound berth makes every berth in that
 * area eligible, not just the bound one). */
async function publishMinimalMap(area: string, boundBerth: string): Promise<void> {
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'Fresh resolution test map') returning id`,
    [`test-map-${randomUUID()}`],
  );
  const mapId = mapResult.rows[0]!.id;
  mapIds.push(mapId);
  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle, effective_from,
       schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 1, 'test')
     returning id`,
    [mapId],
  );
  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, 'test-element', 'td_berth', $2, $3)`,
    [versionResult.rows[0]!.id, area, boundBerth],
  );
}

async function linkFor(occupancy: { id: string; enteredAt: Date }) {
  const r = await pool.query<{ train_run_id: string; link_basis: string }>(
    `select train_run_id, link_basis from berth_occupancy_run_link
     where berth_occupancy_id = $1 and occupancy_entered_at = $2`,
    [occupancy.id, occupancy.enteredAt],
  );
  return r.rows[0] ?? null;
}

function emptySummary(): RunLineageSummary {
  return {
    batches: 0,
    processedEvents: 0,
    stepChainLinks: 0,
    stepChainUpgrades: 0,
    boundaryLinks: 0,
    boundaryAmbiguous: 0,
    freshResolutionAttempts: 0,
    freshResolutionLinks: 0,
  };
}

afterAll(async () => {
  const areas = [AREA_MAPPED, AREA_UNMAPPED, AREA_UPGRADE];
  await pool.query(
    "delete from berth_occupancy_run_link where train_run_id in (select id from train_run where established_td_area = any($1::text[]))",
    [areas],
  );
  await pool.query("delete from train_run where established_td_area = any($1::text[])", [areas]);
  await pool.query("delete from berth_occupancy where td_area = any($1::text[])", [areas]);
  await pool.query("delete from td_berth_event where td_area = any($1::text[])", [areas]);
  if (smartBerthStepIds.length > 0) {
    await pool.query("delete from smart_berth_step where id = any($1::bigint[])", [
      smartBerthStepIds,
    ]);
  }
  if (locationReferenceTiplocs.length > 0) {
    await pool.query("delete from location_reference where tiploc = any($1::text[])", [
      locationReferenceTiplocs,
    ]);
  }
  if (mapIds.length > 0) {
    await pool.query(
      "delete from map_binding_index where map_version_id in (select id from map_version where map_id = any($1::bigint[]))",
      [mapIds],
    );
    await pool.query("delete from map_version where map_id = any($1::bigint[])", [mapIds]);
    await pool.query("delete from map where id = any($1::bigint[])", [mapIds]);
  }
  if (rawEventIds.length > 0) {
    await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  }
  if (scheduleIds.length > 0) {
    await pool.query("delete from cif_schedules where id = any($1::bigint[])", [scheduleIds]);
  }
  await pool.end();
});

describe("sweepFreshResolution (integration)", () => {
  it("establishes a train_run + link for an open, unlinked occupancy in a mapped area", async () => {
    await publishMinimalMap(AREA_MAPPED, "9999"); // a different berth — whole area is eligible.
    await insertMinimalSchedule("PROACTIVE1", "1P01");
    const occ = await insertOpenOccupancy({
      area: AREA_MAPPED,
      berth: "0100",
      description: "1P01",
      enteredAt: T(1),
    });

    const summary = emptySummary();
    await sweepFreshResolution(pool, "mapped", createFreshResolutionCooldown(), summary);

    // Scoped to this fixture's own occupancy — not the aggregate summary counters, which the
    // full `pnpm run test:integration` suite pollutes (every other integration test file shares
    // this same database, and `sweepFreshResolution` deliberately scans *every* eligible area's
    // open occupancies, not just this test's — see this file's own note on why).
    const link = await linkFor(occ);
    expect(link?.link_basis).toBe("resolved");
    expect(summary.freshResolutionLinks).toBeGreaterThanOrEqual(1);
  });

  it("does not attempt resolution in an area with no published map binding, scope=mapped", async () => {
    await insertMinimalSchedule("PROACTIVE2", "1P02");
    const occ = await insertOpenOccupancy({
      area: AREA_UNMAPPED,
      berth: "0200",
      description: "1P02",
      enteredAt: T(1),
    });
    const key = `${occ.id}:${occ.enteredAt.toISOString()}`;

    const cooldown = createFreshResolutionCooldown();
    await sweepFreshResolution(pool, "mapped", cooldown, emptySummary());

    expect(await linkFor(occ)).toBeNull();
    // The SQL query itself excludes ineligible areas, so this occupancy's key never enters the
    // cooldown map at all — a precise, pollution-immune signal that it was never even considered
    // (as opposed to considered-and-failed), unlike the aggregate summary counters.
    expect(cooldown.has(key)).toBe(false);
  });

  it("respects the cooldown — a second sweep within the window does not re-attempt an unmatched occupancy", async () => {
    // No matching cif_schedules row for this headcode — resolution attempts but stays unmatched.
    const occ = await insertOpenOccupancy({
      area: AREA_MAPPED,
      berth: "0300",
      description: "9Z99",
      enteredAt: T(1),
    });
    const key = `${occ.id}:${occ.enteredAt.toISOString()}`;

    const cooldown = createFreshResolutionCooldown();
    await sweepFreshResolution(pool, "mapped", cooldown, emptySummary());
    const firstAttemptAt = cooldown.get(key);
    expect(firstAttemptAt).toBeDefined();
    expect(await linkFor(occ)).toBeNull();

    await sweepFreshResolution(pool, "mapped", cooldown, emptySummary());
    // Unchanged timestamp (not bumped to a later `Date.now()`) proves this specific occupancy was
    // skipped on the second call, not re-attempted — immune to how many *other* occupancies the
    // full suite's shared database causes this sweep to also process.
    expect(cooldown.get(key)).toBe(firstAttemptAt);
  });
});

describe("processStepChainBatch upgrade (integration)", () => {
  // Reproduces a real report (2026-09-15): a train correctly identified by headcode alone at an
  // uncovered origin berth (weak/headcode_only), then stepping into a well-covered berth further
  // down its route — Preston/Lancaster/Carnforth, in the real case — without the match ever
  // strengthening, because step-chain inheritance alone never re-checks position.
  it("upgrades a weak step-chain-inherited link once the destination berth's position data confirms the same schedule", async () => {
    await publishMinimalMap(AREA_UPGRADE, "9998"); // a different berth — whole area is eligible.
    const today = londonToday(new Date());

    const tiploc = `UP${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
    await insertLocationReference(tiploc, "Upgrade Test Loc", stanox);
    await insertSmartBerthStep(AREA_UPGRADE, "0500", stanox); // only the destination is covered.

    const scheduleId = await insertMinimalSchedule("UPGRADE1", "5U01");
    await insertScheduleLocation(Number(scheduleId), 1, tiploc);

    // Origin: a weak link already established at berth 0400, which has no SMART coverage at all.
    const occA = await insertOpenOccupancy({
      area: AREA_UPGRADE,
      berth: "0400",
      description: "5U01",
      enteredAt: T(2),
    });
    const weakRunId = await insertTrainRun({
      cifScheduleId: scheduleId,
      cifTrainUid: "UPGRADE1",
      trafficDay: today,
      matchBasis: "headcode_only",
      matchConfidence: "weak",
      establishedTdArea: AREA_UPGRADE,
      establishedBerth: "0400",
    });
    await insertRunLink(occA, weakRunId, "resolved");

    // Steps into 0500 (well-covered) a minute later.
    const step = await tdBerthStepEvent(AREA_UPGRADE, T(1), "CA", "0400", "0500", "5U01");
    await pool.query(
      `update berth_occupancy set left_at = $1, exit_reason = 'stepped_out', exit_event_id = $2, exit_event_normalized_at_utc = $3
       where id = $4`,
      [step.normalizedAt, step.id, step.normalizedAt, occA.id],
    );
    const occB = await insertOpenOccupancy({
      area: AREA_UPGRADE,
      berth: "0500",
      description: "5U01",
      enteredAt: step.normalizedAt,
      entryReason: "ca_step",
      entryEvent: step,
    });

    await runProjectRunLineage(pool, { batchSize: 50, freshResolutionScope: "mapped" });

    const link = await linkFor(occB);
    expect(link?.link_basis).toBe("resolved"); // upgraded — not left as the inherited "step_chain".
    const run = await pool.query<{
      match_confidence: string;
      cif_schedule_id: string;
    }>(
      `select match_confidence, cif_schedule_id::text as cif_schedule_id from train_run where id = $1`,
      [link!.train_run_id],
    );
    expect(run.rows[0]!.match_confidence).toBe("solid");
    expect(run.rows[0]!.cif_schedule_id).toBe(scheduleId); // confirmed the same physical train.
  });

  it("leaves the inherited weak link untouched when the destination berth has no position data of its own either", async () => {
    const today = londonToday(new Date());
    const scheduleId = await insertMinimalSchedule("UPGRADE2", "5U02");
    // A second, different train sharing this headcode — docs/adr/0008 third addendum made an
    // unscoped match with only one nationwide candidate solid on its own; without this sibling,
    // a fresh look at 0510 would find UPGRADE2 as the sole candidate and correctly upgrade it,
    // defeating this test's actual point (no *genuinely* better evidence exists at either berth).
    await insertMinimalSchedule("UPGRADE2B", "5U02");

    const occA = await insertOpenOccupancy({
      area: AREA_UPGRADE,
      berth: "0410",
      description: "5U02",
      enteredAt: T(2),
    });
    const weakRunId = await insertTrainRun({
      cifScheduleId: scheduleId,
      cifTrainUid: "UPGRADE2",
      trafficDay: today,
      matchBasis: "headcode_only",
      matchConfidence: "weak",
      establishedTdArea: AREA_UPGRADE,
      establishedBerth: "0410",
    });
    await insertRunLink(occA, weakRunId, "resolved");

    // 0510 also has no SMART coverage — a fresh look there can't do any better than the origin did.
    const step = await tdBerthStepEvent(AREA_UPGRADE, T(1), "CA", "0410", "0510", "5U02");
    await pool.query(
      `update berth_occupancy set left_at = $1, exit_reason = 'stepped_out', exit_event_id = $2, exit_event_normalized_at_utc = $3
       where id = $4`,
      [step.normalizedAt, step.id, step.normalizedAt, occA.id],
    );
    const occB = await insertOpenOccupancy({
      area: AREA_UPGRADE,
      berth: "0510",
      description: "5U02",
      enteredAt: step.normalizedAt,
      entryReason: "ca_step",
      entryEvent: step,
    });

    await runProjectRunLineage(pool, { batchSize: 50, freshResolutionScope: "mapped" });

    const link = await linkFor(occB);
    expect(link?.link_basis).toBe("step_chain"); // untouched — no stronger evidence was found.
    expect(link?.train_run_id).toBe(weakRunId); // still pointing at the original weak run, not a new one.
  });
});
