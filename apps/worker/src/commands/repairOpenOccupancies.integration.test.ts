import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { Config } from "../config.js";
import { runRepairOpenOccupancies } from "./repairOpenOccupancies.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
// runRepairOpenOccupancies only reads config.DATABASE_URL.
const config = { DATABASE_URL: requireEnv("DATABASE_URL") } as unknown as Config;
const AREA = `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const rawEventIds: string[] = [];

/** Insert a raw_feed_event + matching td_berth_event; return the identity. */
async function tdEvent(
  eventAt: Date,
  messageType: "CA" | "CB" | "CC",
  fromBerth: string | null,
  toBerth: string | null,
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
    [frame.rows[0]!.id, messageType, AREA, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
        from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, $4, $5, $6, 'RUN1', $2, $7, 1)`,
    [
      row.id,
      row.normalized_event_at_utc,
      AREA,
      messageType,
      fromBerth,
      toBerth,
      row.ingestion_sequence,
    ],
  );
  return { id: row.id, normalizedAt: row.normalized_event_at_utc };
}

async function openInterval(
  berth: string,
  enteredAt: Date,
  entry: { id: string; normalizedAt: Date },
): Promise<void> {
  await pool.query(
    `insert into berth_occupancy (projection_version, td_area, berth_code, description, entered_at,
        left_at, entry_event_id, entry_event_normalized_at_utc, entry_reason)
     values ($1, $2, $3, 'RUN1', $4, null, $5, $6, 'ca_step')`,
    [TD_PROJECTION_VERSION, AREA, berth, enteredAt, entry.id, entry.normalizedAt],
  );
}

async function history(berth: string) {
  const r = await pool.query<{
    entered_at: Date;
    left_at: Date | null;
    exit_reason: string | null;
  }>(
    `select entered_at, left_at, exit_reason from berth_occupancy
      where projection_version = $1 and td_area = $2 and berth_code = $3
      order by entered_at asc`,
    [TD_PROJECTION_VERSION, AREA, berth],
  );
  return r.rows;
}

const T = (min: number): Date => new Date(Date.parse("2026-06-01T10:00:00.000Z") + min * 60_000);

afterAll(async () => {
  await pool.query("delete from berth_occupancy where td_area = $1", [AREA]);
  await pool.query("delete from td_berth_event where td_area = $1", [AREA]);
  if (rawEventIds.length > 0) {
    await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  }
  await pool.end();
});

describe("repair-open-occupancies (integration)", () => {
  it("closes stale open intervals at the step-out time and leaves the newest open", async () => {
    // A run stepped 0001 -> 0002 -> 0003; the two CAs exist in td_berth_event but the
    // occupancies for 0001 and 0002 were never closed (the ADR 0003 getOpenOccupancy bug).
    const e1 = await tdEvent(T(0), "CC", null, "0001");
    await openInterval("0001", T(0), e1);
    const e2 = await tdEvent(T(1), "CA", "0001", "0002"); // stepped out of 0001 at +1
    await openInterval("0002", T(1), e2);
    const e3 = await tdEvent(T(2), "CA", "0002", "0003"); // stepped out of 0002 at +2
    await openInterval("0003", T(2), e3);

    await runRepairOpenOccupancies(config, []);

    const h1 = await history("0001");
    expect(h1).toHaveLength(1);
    expect(h1[0]!.left_at?.getTime()).toBe(T(1).getTime());
    expect(h1[0]!.exit_reason).toBe("repaired_stepped_out");

    const h2 = await history("0002");
    expect(h2[0]!.left_at?.getTime()).toBe(T(2).getTime());

    const h3 = await history("0003");
    expect(h3[0]!.left_at).toBeNull(); // the current occupant stays open

    // Idempotent.
    await runRepairOpenOccupancies(config, []);
    expect((await history("0001"))[0]!.left_at?.getTime()).toBe(T(1).getTime());
  });

  it("falls back to the next interval's entered_at when no step-out event exists", async () => {
    // 0009 was entered twice with no CA/CB ever stepping a train out of it.
    const a = await tdEvent(T(10), "CC", null, "0009");
    await openInterval("0009", T(10), a);
    const b = await tdEvent(T(40), "CC", null, "0009");
    await openInterval("0009", T(40), b);

    await runRepairOpenOccupancies(config, []);

    const h = await history("0009");
    expect(h).toHaveLength(2);
    expect(h[0]!.left_at?.getTime()).toBe(T(40).getTime()); // bounded by the next entry
    expect(h[0]!.exit_reason).toBe("repaired_no_exit_event");
    expect(h[1]!.left_at).toBeNull();
  });
});
