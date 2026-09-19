import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { runProjectVirtualBerths } from "./projector.js";

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
async function bindVirtualBerth(stanox: string): Promise<void> {
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

describe("runProjectVirtualBerths (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

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
});
