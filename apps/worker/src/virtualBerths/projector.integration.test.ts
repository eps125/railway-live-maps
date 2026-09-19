import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import type { LiveDeltaMessage } from "@railway/protocol";
import {
  runProjectVirtualBerths,
  runVirtualBerthTdReentryHandoff,
  type RedisPublisher,
} from "./projector.js";

class CapturingRedisPublisher implements RedisPublisher {
  published: Array<{ channel: string; message: LiveDeltaMessage }> = [];
  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message: JSON.parse(message) as LiveDeltaMessage });
    return 1;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

/** GPS-sourced, on-time, automatic departure: eventKind bits (0x01) | variation on_time (0x08)
 * | originalDataSource GPS (5 << 8 = 0x0500), matching packages/domain/src/trust/
 * garnerMovement.ts's decode exactly (and the real openrail-eps trustdb.c patch, commit
 * b9f3538) — see that file's own bit-layout doc comment. */
const GPS_FLAGS = 0x01 | 0x08 | (5 << 8);
const GPS_FLAGS_TERMINATED = GPS_FLAGS | 0x40;

async function insertMovement(trustId: string, stanox: string, at: Date): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into trust_movement (trust_id, created, platform, loc_stanox, actual_timestamp, flags)
     values ($1, $2, '', $3, $2, $4)
     returning id::text as id`,
    [trustId, at, stanox, GPS_FLAGS],
  );
  return result.rows[0]!.id;
}

async function insertTerminatingMovement(
  trustId: string,
  stanox: string,
  at: Date,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into trust_movement (trust_id, created, platform, loc_stanox, actual_timestamp, flags)
     values ($1, $2, '', $3, $2, $4)
     returning id::text as id`,
    [trustId, at, stanox, GPS_FLAGS_TERMINATED],
  );
  return result.rows[0]!.id;
}

/** A minimal map_version + map_binding_index row binding `stanox` as a virtual berth — enough
 * for `isVirtualBerthStanox` to find it, without going through a full publish. */
async function bindVirtualBerth(stanox: string): Promise<string> {
  const slug = `test-vb-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $1) returning id`,
    [slug],
  );
  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 'test', 1, 'test-checksum')
     returning id`,
    [mapResult.rows[0]!.id],
  );
  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, stanox)
     values ($1, $2, 'virtual_berth', $3)`,
    [versionResult.rows[0]!.id, `elem-${stanox}`, stanox],
  );
  return slug;
}

async function currentState(
  stanox: string,
): Promise<{ trust_id: string | null; headcode: string | null } | undefined> {
  const result = await pool.query<{ trust_id: string | null; headcode: string | null }>(
    `select trust_id, headcode from virtual_berth_current_state where stanox = $1`,
    [stanox],
  );
  return result.rows[0];
}

/** Minimal real td_berth_event row (raw_archive_object -> feed_frame -> raw_feed_event ->
 * td_berth_event), same pattern as apps/worker/src/runLineage/projector.integration.test.ts's
 * own `tdEvent` helper — needed to exercise `runVirtualBerthTdReentryHandoff`, which reads
 * `td_berth_event` directly. */
async function tdEvent(headcode: string, messageType: "CA" | "CC", at: Date): Promise<void> {
  const area = `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
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
    [frame.rows[0]!.id, messageType, area, at, randomUUID()],
  );
  const row = ev.rows[0]!;
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
        from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, $4, $5, $6, $7, $2, $8, 1)`,
    [
      row.id,
      row.normalized_event_at_utc,
      area,
      messageType,
      messageType === "CA" ? "0000" : null,
      "0001",
      headcode,
      row.ingestion_sequence,
    ],
  );
}

afterAll(async () => {
  // File-scoped, not nested in either describe block below: both share this module-level `pool`,
  // and Vitest runs the two top-level describes in declaration order within one file — nesting
  // this inside the first block would end the pool before the second block's tests ever run.
  await pool.end();
});

describe("runProjectVirtualBerths (integration)", () => {
  it("opens an occupancy for a GPS report at a bound STANOX, ignores an unbound one", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const boundStanox = `B${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const unboundStanox = `U${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(boundStanox);

    await insertMovement(trustId, unboundStanox, new Date());
    const at = new Date();
    await insertMovement(trustId, boundStanox, at);

    await runProjectVirtualBerths(pool);

    const state = await currentState(boundStanox);
    expect(state?.trust_id).toBe(trustId);

    const unboundState = await currentState(unboundStanox);
    expect(unboundState).toBeUndefined();
  });

  it("steps: closes the previous virtual berth and opens the new one for the same trust_id", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanoxA = `A${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const stanoxB = `C${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanoxA);
    await bindVirtualBerth(stanoxB);

    const t0 = new Date(Date.now() - 60_000);
    const t1 = new Date();
    await insertMovement(trustId, stanoxA, t0);
    await insertMovement(trustId, stanoxB, t1);

    await runProjectVirtualBerths(pool);

    expect((await currentState(stanoxA))?.trust_id).toBeNull();
    expect((await currentState(stanoxB))?.trust_id).toBe(trustId);

    const occupancy = await pool.query<{ left_at: Date | null; exit_reason: string | null }>(
      `select left_at, exit_reason from virtual_berth_occupancy
       where trust_id = $1 and stanox = $2`,
      [trustId, stanoxA],
    );
    expect(occupancy.rows[0]?.left_at).not.toBeNull();
    expect(occupancy.rows[0]?.exit_reason).toBe("stepped_to_virtual");
  });

  it("clears the virtual berth immediately when the report says the train terminated", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanox = `D${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanox);

    await insertTerminatingMovement(trustId, stanox, new Date());
    await runProjectVirtualBerths(pool);

    expect((await currentState(stanox))?.trust_id).toBeNull();
    const occupancy = await pool.query<{ exit_reason: string | null }>(
      `select exit_reason from virtual_berth_occupancy where trust_id = $1 and stanox = $2`,
      [trustId, stanox],
    );
    expect(occupancy.rows[0]?.exit_reason).toBe("terminated");
  });

  it("batches in numeric id order across a digit-count boundary (never text order)", async () => {
    // Regression: `select id::text as id ... order by id` sorted by the text alias, so "10…0"
    // came before "9…9", the checkpoint jumped to the larger id and the smaller row was skipped.
    // Move the sequence (forward only) so the next two ids straddle a power of ten.
    const { rows } = await pool.query<{ last_value: string }>(
      `select last_value::text as last_value from trust_movement_id_seq`,
    );
    const boundary = 10n ** BigInt(rows[0]!.last_value.length + 1);
    await pool.query(`select setval('trust_movement_id_seq', $1)`, [(boundary - 2n).toString()]);

    const trustA = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const trustB = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanoxA = `F${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const stanoxB = `G${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanoxA);
    await bindVirtualBerth(stanoxB);

    const idA = await insertMovement(trustA, stanoxA, new Date());
    const idB = await insertMovement(trustB, stanoxB, new Date());
    expect(idA.length).toBeLessThan(idB.length);

    await runProjectVirtualBerths(pool, { batchSize: 1 });

    expect((await currentState(stanoxA))?.trust_id).toBe(trustA);
    expect((await currentState(stanoxB))?.trust_id).toBe(trustB);
  });

  it("is idempotent — reprocessing the same rows (checkpoint held back) does not duplicate occupancy rows", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanox = `E${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanox);
    const movementId = await insertMovement(trustId, stanox, new Date());
    void movementId;

    await runProjectVirtualBerths(pool);
    await runProjectVirtualBerths(pool); // checkpoint already past this row — no-op, not a re-run

    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count from virtual_berth_occupancy where trust_id = $1`,
      [trustId],
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("--rebuild reproduces the same current state from an empty projection", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanox = `F${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanox);
    await insertMovement(trustId, stanox, new Date());

    await runProjectVirtualBerths(pool);
    const before = await currentState(stanox);

    await runProjectVirtualBerths(pool, { rebuild: true });
    const after = await currentState(stanox);

    expect(after).toEqual(before);
    expect(after?.trust_id).toBe(trustId);
  });

  it("publishes a berth.updated delta to every published map's channel that binds the stanox, with a monotonic sequence", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanox = `K${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const slug = await bindVirtualBerth(stanox);
    const redis = new CapturingRedisPublisher();

    await insertMovement(trustId, stanox, new Date());
    await runProjectVirtualBerths(pool, { redis });

    const forThisSlug = redis.published.filter((p) => p.channel === `railway:live:${slug}`);
    expect(forThisSlug).toHaveLength(1);
    expect(forThisSlug[0]!.message).toMatchObject({ type: "berth.updated", stanox });
    expect(forThisSlug[0]!.message.sequence).toBeGreaterThan(0);
  });
});

describe("runVirtualBerthTdReentryHandoff (integration)", () => {
  it("closes a virtual occupancy when exactly one open occupancy shares the TD event's headcode", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const headcode = trustId.slice(2, 6);
    const stanox = `G${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanox);
    await insertMovement(trustId, stanox, new Date(Date.now() - 5 * 60_000));
    await runProjectVirtualBerths(pool);
    expect((await currentState(stanox))?.trust_id).toBe(trustId);

    await tdEvent(headcode, "CC", new Date());
    await runVirtualBerthTdReentryHandoff(pool);

    expect((await currentState(stanox))?.trust_id).toBeNull();
    const occupancy = await pool.query<{ exit_reason: string | null }>(
      `select exit_reason from virtual_berth_occupancy where trust_id = $1`,
      [trustId],
    );
    expect(occupancy.rows[0]?.exit_reason).toBe("stepped_to_td");
  });

  it("never guesses when more than one open occupancy shares the same headcode", async () => {
    // headcodeFromTrustId reads slice(2, 6) — the seed must sit at indices 2-5, so each prefix
    // needs to be exactly 2 characters (not 1) for the slice to actually line up with it.
    const headcodeSeed = randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
    const trustIdA = `T1${headcodeSeed}${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const trustIdB = `X2${headcodeSeed}${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const headcode = trustIdA.slice(2, 6);
    expect(trustIdB.slice(2, 6)).toBe(headcode); // both encode the same 4-char headcode
    const stanoxA = `H${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const stanoxB = `I${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanoxA);
    await bindVirtualBerth(stanoxB);
    await insertMovement(trustIdA, stanoxA, new Date(Date.now() - 5 * 60_000));
    await insertMovement(trustIdB, stanoxB, new Date(Date.now() - 5 * 60_000));
    await runProjectVirtualBerths(pool);

    await tdEvent(headcode, "CC", new Date());
    await runVirtualBerthTdReentryHandoff(pool);

    // Ambiguous — neither should be closed by this pass (CLAUDE.md rule 7: never guess).
    expect((await currentState(stanoxA))?.trust_id).toBe(trustIdA);
    expect((await currentState(stanoxB))?.trust_id).toBe(trustIdB);
  });

  it("leaves a virtual occupancy untouched when no TD event shares its headcode", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
    const stanox = `J${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await bindVirtualBerth(stanox);
    await insertMovement(trustId, stanox, new Date(Date.now() - 5 * 60_000));
    await runProjectVirtualBerths(pool);

    await tdEvent("9Z99", "CC", new Date());
    await runVirtualBerthTdReentryHandoff(pool);

    expect((await currentState(stanox))?.trust_id).toBe(trustId);
  });
});
