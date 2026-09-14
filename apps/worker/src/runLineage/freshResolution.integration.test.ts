import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import {
  sweepFreshResolution,
  createFreshResolutionCooldown,
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
const rawEventIds: string[] = [];
const scheduleIds: string[] = [];
const mapIds: string[] = [];

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
}): Promise<{ id: string; enteredAt: Date }> {
  const entryEvent = await tdEvent(params.area, params.enteredAt);
  const result = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, null, $6, $7, 'cc_interpose')
     returning id`,
    [
      TD_PROJECTION_VERSION,
      params.area,
      params.berth,
      params.description,
      params.enteredAt,
      entryEvent.id,
      entryEvent.normalizedAt,
    ],
  );
  return { id: result.rows[0]!.id, enteredAt: params.enteredAt };
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
    boundaryLinks: 0,
    boundaryAmbiguous: 0,
    freshResolutionAttempts: 0,
    freshResolutionLinks: 0,
  };
}

afterAll(async () => {
  await pool.query(
    "delete from berth_occupancy_run_link where train_run_id in (select id from train_run where established_td_area = any($1::text[]))",
    [[AREA_MAPPED, AREA_UNMAPPED]],
  );
  await pool.query("delete from train_run where established_td_area = any($1::text[])", [
    [AREA_MAPPED, AREA_UNMAPPED],
  ]);
  await pool.query("delete from berth_occupancy where td_area = any($1::text[])", [
    [AREA_MAPPED, AREA_UNMAPPED],
  ]);
  await pool.query("delete from td_berth_event where td_area = any($1::text[])", [
    [AREA_MAPPED, AREA_UNMAPPED],
  ]);
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
