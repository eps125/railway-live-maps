import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import type { CompiledMapBundle } from "@railway/map-schema";
import { insertMapBindingIndexRows } from "@railway/map-publish";

/**
 * Milestone 59 / ADR 0015: publishing an inferred crossing writes one `td_s_bit_barrier_input` row
 * per input signal, which migration 0040's widened check constraints must accept — including the
 * common case where an input bit is *also* bound to a drawn signal in the same map version.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const mapIds: string[] = [];

afterAll(async () => {
  if (mapIds.length > 0) {
    await pool.query(
      "delete from map_binding_index where map_version_id in (select id from map_version where map_id = any($1::bigint[]))",
      [mapIds],
    );
    await pool.query("delete from map_version where map_id = any($1::bigint[])", [mapIds]);
    await pool.query("delete from map where id = any($1::bigint[])", [mapIds]);
  }
  await pool.end();
});

async function newMapVersion(): Promise<string> {
  const slug = `mbi-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const map = await pool.query<{ id: string }>(
    "insert into map (slug, name) values ($1, 'Binding Index Test') returning id",
    [slug],
  );
  mapIds.push(map.rows[0]!.id);
  const version = await pool.query<{ id: string }>(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
        effective_from, effective_to, published_by, schema_version, checksum)
     values ($1, 1, '{}', '{}', now(), null, 'test', 1, 'v1') returning id`,
    [map.rows[0]!.id],
  );
  return version.rows[0]!.id;
}

describe("insertMapBindingIndexRows — inferred crossings (integration, migration 0040)", () => {
  it("writes one input row per signal, alongside a signal bound to the same bit", async () => {
    const versionId = await newMapVersion();
    const bundle = {
      berthBindingIndex: {},
      // S3879 is drawn AND feeds the crossing: byte 07 bit 4 appears twice, as two binding types.
      sBitBindingIndex: { "M9|07|4": "sig-3879" },
      sBitBindingActiveMeans: { "M9|07|4": "off" },
      inferredBarrierBindings: {
        "lx-carleton": [
          { tdArea: "M9", address: "07", bit: 4, activeMeans: "off" },
          { tdArea: "M9", address: "06", bit: 6, activeMeans: "off" },
        ],
      },
    } as unknown as CompiledMapBundle;

    await insertMapBindingIndexRows(pool, versionId, bundle);
    // Idempotent, as every other binding type is.
    await insertMapBindingIndexRows(pool, versionId, bundle);

    const rows = await pool.query<{
      element_id: string;
      binding_type: string;
      td_area: string;
      address: string;
      /** A text column (migration 0010); the live publisher coerces it on read. */
      bit: string;
      active_means: string;
    }>(
      `select element_id, binding_type, td_area, address, bit, active_means
       from map_binding_index where map_version_id = $1
       order by binding_type, address desc`,
      [versionId],
    );
    expect(rows.rows).toEqual([
      {
        element_id: "sig-3879",
        binding_type: "td_s_bit",
        td_area: "M9",
        address: "07",
        bit: "4",
        active_means: "off",
      },
      {
        element_id: "lx-carleton",
        binding_type: "td_s_bit_barrier_input",
        td_area: "M9",
        address: "07",
        bit: "4",
        active_means: "off",
      },
      {
        element_id: "lx-carleton",
        binding_type: "td_s_bit_barrier_input",
        td_area: "M9",
        address: "06",
        bit: "6",
        active_means: "off",
      },
    ]);
  });

  it("refuses a barrier vocabulary on an input row — an input is a signal", async () => {
    const versionId = await newMapVersion();
    await expect(
      pool.query(
        `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit, active_means)
         values ($1, 'lx-x', 'td_s_bit_barrier_input', 'M9', '07', 4, 'down')`,
        [versionId],
      ),
    ).rejects.toThrow(/map_binding_index_active_means_check/);
  });
});
