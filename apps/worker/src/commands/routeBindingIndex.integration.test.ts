import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import type { CompiledMapBundle } from "@railway/map-schema";
import { insertMapBindingIndexRows } from "@railway/map-publish";

/**
 * Milestone 64 / ADR 0016: publishing a route writes a `td_s_bit_route` row, which migration
 * 0042's widened check constraints must accept alongside a signal bound to a bit of the same byte,
 * and must refuse in any vocabulary but set/unset.
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

describe("insertMapBindingIndexRows — routes (integration, migration 0042)", () => {
  it("writes a route row in its own binding type, next to a signal on the same byte", async () => {
    const versionId = await newMapVersion();
    const bundle = {
      berthBindingIndex: {},
      sBitBindingIndex: { "M9|0C|2": "sig-3870" },
      sBitBindingActiveMeans: { "M9|0C|2": "off" },
      routeBindingIndex: { "M9|0C|4": "route-3879a" },
      routeBindingActiveMeans: { "M9|0C|4": "set" },
    } as unknown as CompiledMapBundle;

    await insertMapBindingIndexRows(pool, versionId, bundle);
    // Idempotent, as every other binding type is.
    await insertMapBindingIndexRows(pool, versionId, bundle);

    const rows = await pool.query<{
      element_id: string;
      binding_type: string;
      address: string;
      bit: string;
      active_means: string;
    }>(
      `select element_id, binding_type, address, bit, active_means
       from map_binding_index where map_version_id = $1
       order by binding_type`,
      [versionId],
    );
    expect(rows.rows).toEqual([
      {
        element_id: "sig-3870",
        binding_type: "td_s_bit",
        address: "0C",
        bit: "2",
        active_means: "off",
      },
      {
        element_id: "route-3879a",
        binding_type: "td_s_bit_route",
        address: "0C",
        bit: "4",
        active_means: "set",
      },
    ]);
  });

  it("refuses a signal or barrier vocabulary on a route row, and a route vocabulary on a signal", async () => {
    const versionId = await newMapVersion();
    const insert = (bindingType: string, activeMeans: string, bit: number) =>
      pool.query(
        `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, address, bit, active_means)
         values ($1, 'x', $2, 'M9', '0C', $3, $4)`,
        [versionId, bindingType, bit, activeMeans],
      );
    await expect(insert("td_s_bit_route", "off", 4)).rejects.toThrow(
      /map_binding_index_active_means_check/,
    );
    await expect(insert("td_s_bit_route", "down", 5)).rejects.toThrow(
      /map_binding_index_active_means_check/,
    );
    await expect(insert("td_s_bit", "set", 6)).rejects.toThrow(
      /map_binding_index_active_means_check/,
    );
  });
});
