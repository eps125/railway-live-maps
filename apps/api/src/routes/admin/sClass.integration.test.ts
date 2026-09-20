import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_S_STATE_PROJECTION_VERSION } from "@railway/domain";
import { registerSClassAdminRoutes, registerSClassEditorRoutes } from "./sClass.js";

/** Milestone 36c: admin S-Class explorer + definitions (integration). */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
// Real TD areas are two characters (the routes enforce it); "9x" isn't a real area code.
const AREA = `9${"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]}`;
const rawIds: string[] = [];

async function rawEvent(at: Date, messageClass: "C" | "S", eventType: string) {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', $2, $1, $3) returning id`,
    [randomUUID(), at, archive.rows[0]!.id],
  );
  const ev = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, $3, $4, '{}', $5, $5, $6, 'parsed', 1)
     returning id, ingestion_sequence::text`,
    [frame.rows[0]!.id, eventType, messageClass, AREA, at, randomUUID()],
  );
  rawIds.push(ev.rows[0]!.id);
  return ev.rows[0]!;
}

async function berthStep(from: string, to: string, at: Date): Promise<void> {
  const raw = await rawEvent(at, "C", "CA");
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
       from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, 'CA', $4, $5, '1A23', $2, $6, 1)`,
    [raw.id, at, AREA, from, to, raw.ingestion_sequence],
  );
}

async function bitChange(
  address: string,
  bit: number,
  previous: boolean | null,
  next: boolean,
  at: Date,
): Promise<void> {
  const raw = await rawEvent(at, "S", "SF_MSG");
  await pool.query(
    `insert into td_s_bit_transition (projection_version, td_area, address, bit_index,
       previous_value, new_value, event_at, source_event_id, source_event_normalized_at_utc,
       source_kind, source_ingestion_sequence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $7, 'update', $9)`,
    [
      TD_S_STATE_PROJECTION_VERSION,
      AREA,
      address,
      bit,
      previous,
      next,
      at,
      raw.id,
      raw.ingestion_sequence,
    ],
  );
}

async function currentByte(address: string, value: number, at: Date): Promise<void> {
  const raw = await rawEvent(at, "S", "SF_MSG");
  await pool.query(
    `insert into td_s_current_state (projection_version, td_area, address, raw_value, byte_value,
       decoded_bitset, event_at, source_event_id, source_event_normalized_at_utc,
       source_ingestion_sequence, decode_status, source_kind)
     values ($1, $2, $3, 'xx', $4, '[]', $5, $6, $5, $7, 'decoded', 'update')`,
    [TD_S_STATE_PROJECTION_VERSION, AREA, address, value, at, raw.id, raw.ingestion_sequence],
  );
}

const minutesAgo = (m: number, plusSeconds = 0): Date =>
  new Date(Date.now() - m * 60_000 + plusSeconds * 1000);

beforeAll(async () => {
  await currentByte("03", 0b0000_0100, minutesAgo(1));
  await currentByte("04", 0x00, minutesAgo(1));
  // Three trains step 0100 -> 0102; each time bit 03:2 clears 2 s later (the signal between
  // those berths returning to red), and on one of them an unrelated bit 04:0 also changes.
  for (const m of [50, 40, 30]) {
    await berthStep("0100", "0102", minutesAgo(m));
    await bitChange("03", 2, true, false, minutesAgo(m, 2));
    await bitChange("03", 2, false, true, minutesAgo(m - 5)); // cleared again later (no step)
  }
  await bitChange("04", 0, false, true, minutesAgo(40, -3));
  await berthStep("0200", "0202", minutesAgo(20)); // unrelated step, nothing near it
});

afterAll(async () => {
  await pool.query("delete from s_class_definition_revision where td_area = $1", [AREA]);
  await pool.query("delete from s_class_definition where td_area = $1", [AREA]);
  await pool.query("delete from td_s_bit_transition where td_area = $1", [AREA]);
  await pool.query("delete from td_s_current_state where td_area = $1", [AREA]);
  await pool.query("delete from td_berth_event where td_area = $1", [AREA]);
  await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawIds]);
  await pool.end();
});

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    (request as unknown as { authSession: { username: string } }).authSession = {
      username: "owner",
    };
  });
  await registerSClassAdminRoutes(app, { pool });
  await registerSClassEditorRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("admin S-Class explorer (integration)", () => {
  it("lists the area and its live bit grid with 24 h change counts", async () => {
    const app = await buildApp();
    try {
      const areas = (await app.inject({ url: "/api/v1/admin/s-class/areas" })).json();
      expect(areas.areas).toContainEqual(expect.objectContaining({ tdArea: AREA, bytes: 2 }));

      const grid = (await app.inject({ url: `/api/v1/admin/s-class/areas/${AREA}/bits` })).json();
      const byte03 = grid.bytes.find((b: { address: string }) => b.address === "03");
      expect(byte03.value).toBe(4);
      expect(byte03.bits[2]).toMatchObject({ bit: 2, value: true, changes: 6 });
      expect(byte03.bits[0]).toMatchObject({ value: false, changes: 0, lastChangedAt: null });
    } finally {
      await app.close();
    }
  });

  it("returns a bit's history newest first", async () => {
    const app = await buildApp();
    try {
      const body = (
        await app.inject({ url: `/api/v1/admin/s-class/areas/${AREA}/bits/3/2/history` })
      ).json();
      expect(body.transitions).toHaveLength(6);
      const times = body.transitions.map((t: { eventAt: string }) => Date.parse(t.eventAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
    } finally {
      await app.close();
    }
  });

  it("suggests the berth step a bit's changes line up with", async () => {
    const app = await buildApp();
    try {
      const body = (
        await app.inject({
          url: `/api/v1/admin/s-class/areas/${AREA}/bits/03/2/correlated-steps`,
        })
      ).json();
      expect(body.transitions).toEqual({ set: 3, cleared: 3 });
      expect(body.steps[0]).toMatchObject({
        direction: "cleared",
        fromBerth: "0100",
        toBerth: "0102",
        hits: 3,
        ofTransitions: 3,
      });
      expect(body.steps[0].medianOffsetSeconds).toBeCloseTo(-2, 0);
    } finally {
      await app.close();
    }
  });

  it("suggests the bit for a berth step, strongest match first", async () => {
    const app = await buildApp();
    try {
      const body = (
        await app.inject({
          url: `/api/v1/admin/s-class/areas/${AREA}/correlated-bits?fromBerth=0100&toBerth=0102`,
        })
      ).json();
      expect(body.steps).toBe(3);
      expect(body.bits[0]).toMatchObject({
        address: "03",
        bit: 2,
        direction: "cleared",
        hits: 3,
        ofSteps: 3,
      });
      expect(body.bits[1]).toMatchObject({ address: "04", bit: 0, hits: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed area, address or bit", async () => {
    const app = await buildApp();
    try {
      expect(
        (await app.inject({ url: `/api/v1/admin/s-class/areas/${AREA}/bits/ZZ/2/history` }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: `/api/v1/admin/s-class/areas/${AREA}/bits/03/8/history` }))
          .statusCode,
      ).toBe(400);
      expect((await app.inject({ url: "/api/v1/admin/s-class/areas/PXX/bits" })).statusCode).toBe(
        400,
      );
    } finally {
      await app.close();
    }
  });
});

describe("S-Class definitions (integration)", () => {
  it("creates, updates and deletes a definition, recording every revision", async () => {
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/s-class/areas/${AREA}/definitions/3/2`,
        payload: { kind: "signal", label: "S123", source: "observed" },
      });
      expect(created.json()).toMatchObject({
        outcome: "created",
        definition: { address: "03", bit: 2, label: "S123", updatedBy: "owner" },
      });
      const same = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/s-class/areas/${AREA}/definitions/03/2`,
        payload: { kind: "signal", label: "S123", source: "observed" },
      });
      expect(same.json().outcome).toBe("unchanged");
      await app.inject({
        method: "PUT",
        url: `/api/v1/admin/s-class/areas/${AREA}/definitions/03/2`,
        payload: { kind: "signal", label: "S125", source: "observed", notes: "corrected" },
      });
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/s-class/areas/${AREA}/definitions/03/2`,
      });
      expect(removed.statusCode).toBe(204);

      const revisions = await pool.query<{ action: string; changed_by: string }>(
        `select action, changed_by from s_class_definition_revision
          where td_area = $1 and address = '03' and bit = 2 order by id`,
        [AREA],
      );
      expect(revisions.rows.map((r) => r.action)).toEqual(["create", "update", "delete"]);
      expect(revisions.rows.every((r) => r.changed_by === "owner")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid kind", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/s-class/areas/${AREA}/definitions/03/1`,
        payload: { kind: "aspect", label: "S1" },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("import: requires a radix, previews, refuses errors, and only overwrites conflicts on request", async () => {
    const app = await buildApp();
    const url = `/api/v1/admin/s-class/areas/${AREA}/definitions/import`;
    try {
      const noRadix = await app.inject({ method: "POST", url, payload: { text: "03:0\tS1" } });
      expect(noRadix.statusCode).toBe(400);
      expect(noRadix.json().error.code).toBe("RADIX_REQUIRED");

      // An existing definition the import will conflict with.
      await app.inject({
        method: "PUT",
        url: `/api/v1/admin/s-class/areas/${AREA}/definitions/0A/0`,
        payload: { kind: "signal", label: "S9999", source: "observed" },
      });

      const table = "Address\tFunction\n03:0\tS3471\n0A:0\tS3472\n0B:1\t?\n";
      const preview = await app.inject({
        method: "POST",
        url,
        payload: { text: table, radix: "hex", source: "wiki" },
      });
      expect(preview.json()).toMatchObject({
        committed: false,
        counts: { new: 1, conflict: 1, skippedUnidentified: 1 },
      });

      const withErrors = await app.inject({
        method: "POST",
        url,
        payload: { text: "03:0\tS1\n03:0\tS2", radix: "hex", dryRun: false },
      });
      expect(withErrors.statusCode).toBe(422);

      const committed = await app.inject({
        method: "POST",
        url,
        payload: { text: table, radix: "hex", source: "wiki", dryRun: false },
      });
      expect(committed.json()).toMatchObject({ committed: true, applied: 1 });
      const defs = (
        await app.inject({ url: `/api/v1/editor/s-class/areas/${AREA}/definitions` })
      ).json().definitions;
      expect(defs.find((d: { address: string }) => d.address === "0A").label).toBe("S9999");
      expect(defs.find((d: { address: string }) => d.address === "03" && true)).toMatchObject({
        label: "S3471",
        source: "wiki",
      });

      const overwrite = await app.inject({
        method: "POST",
        url,
        payload: {
          text: table,
          radix: "hex",
          source: "wiki",
          dryRun: false,
          overwriteConflicts: true,
        },
      });
      expect(overwrite.json().applied).toBe(1);
      const after = (
        await app.inject({ url: `/api/v1/editor/s-class/areas/${AREA}/definitions` })
      ).json().definitions;
      expect(after.find((d: { address: string }) => d.address === "0A").label).toBe("S3472");
    } finally {
      await app.close();
    }
  });
});
