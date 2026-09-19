import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { VIRTUAL_BERTH_PROJECTION_VERSION } from "@railway/domain";
import { registerCurrentRunRoutes } from "./currentRun.js";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session.js";

/**
 * docs/adr/0012: `GET /api/v1/virtual-berths/{stanox}/current-run`. Mirrors the setup shape of
 * `currentRun.integration.test.ts` but standalone/minimal — a direct trust_id lookup has no
 * candidate-tie-break machinery to exercise, so this doesn't need that file's large fixture set.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdScheduleIds: number[] = [];
const createdTrustIds: string[] = [];
const createdStanoxes: string[] = [];

class FakeRedis {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
  async expire(): Promise<number> {
    return 1;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}
const fakeRedis = new FakeRedis() as unknown as Redis;
const SESSION_TTL_SECONDS = 3600;

async function authHeaders(): Promise<{ cookie: string }> {
  const token = await createSession(
    fakeRedis,
    { userId: randomUUID(), username: "test-editor", role: "editor" },
    SESSION_TTL_SECONDS,
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

let nextScheduleId = Date.now();

async function seedSchedule(): Promise<number> {
  const id = nextScheduleId++;
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, signalling_id, atoc_code, cif_train_service_code
     ) values ($1, now(), 'P', $2, true,true,true,true,true,true,true,
       (now() - interval '30 days')::date, (now() + interval '30 days')::date, '1A00', 'NT', '11111000')`,
    [id, `U${id}`],
  );
  createdScheduleIds.push(id);
  return id;
}

async function seedActivation(scheduleId: number): Promise<string> {
  const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  createdTrustIds.push(trustId);
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id, deduced) values ($1, now(), $2, 0)`,
    [trustId, scheduleId],
  );
  return trustId;
}

async function seedVirtualCurrentState(
  stanox: string,
  trustId: string,
  headcode: string | null,
): Promise<void> {
  createdStanoxes.push(stanox);
  if (!createdTrustIds.includes(trustId)) createdTrustIds.push(trustId);
  // virtual_berth_current_state.source_trust_movement_id is a not-null FK — a throwaway row
  // satisfies it without needing this file to know anything about a real GPS report's shape.
  const movement = await pool.query<{ id: string }>(
    `insert into trust_movement (trust_id, created, platform, loc_stanox, actual_timestamp, flags)
     values ($1, now(), '', $2, now(), 0) returning id`,
    [trustId, stanox],
  );
  await pool.query(
    `insert into virtual_berth_current_state
       (projection_version, stanox, trust_id, headcode, occupancy_entered_at, event_at, source_trust_movement_id)
     values ($1, $2, $3, $4, now(), now(), $5)`,
    [VIRTUAL_BERTH_PROJECTION_VERSION, stanox, trustId, headcode, movement.rows[0]!.id],
  );
}

async function buildApp() {
  const app = Fastify();
  await app.register(fastifyCookie);
  await registerCurrentRunRoutes(app, {
    pool,
    redis: fakeRedis,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  });
  await app.ready();
  return app;
}

afterAll(async () => {
  if (createdStanoxes.length > 0) {
    // Before trust_movement (below) — virtual_berth_current_state.source_trust_movement_id FKs
    // into it with no cascade.
    await pool.query("delete from virtual_berth_current_state where stanox = any($1::text[])", [
      createdStanoxes,
    ]);
  }
  if (createdTrustIds.length > 0) {
    await pool.query("delete from trust_movement where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
    await pool.query("delete from trust_activation where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
  }
  if (createdScheduleIds.length > 0) {
    await pool.query("delete from cif_schedules where id = any($1::bigint[])", [
      createdScheduleIds,
    ]);
  }
  await pool.end();
});

describe("GET /api/v1/virtual-berths/:stanox/current-run", () => {
  it("404s BERTH_NOT_OCCUPIED for a stanox with no current occupant", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/virtual-berths/${randomUUID().replace(/-/g, "").slice(0, 6)}/current-run`,
      headers: await authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("BERTH_NOT_OCCUPIED");
  });

  it("matches directly via the occupant's own trust_id — virtual_direct, never ambiguous", async () => {
    const scheduleId = await seedSchedule();
    const trustId = await seedActivation(scheduleId);
    const stanox = `V${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await seedVirtualCurrentState(stanox, trustId, "1A00");

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/virtual-berths/${stanox}/current-run`,
      headers: await authHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.matchStatus).toBe("matched");
    expect(body.matchBasis).toBe("virtual_direct");
    expect(body.headcode).toBe("1A00");
    expect(body.effective.scheduleId).toBe(String(scheduleId));
  });

  it("reports unmatched when garner has no linked schedule for this trust_id", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const stanox = `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await seedVirtualCurrentState(stanox, trustId, "2B00");

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/virtual-berths/${stanox}/current-run`,
      headers: await authHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().matchStatus).toBe("unmatched");
  });

  it("404s NO_PUBLIC_DETAIL for an anonymous request against an unmatched virtual berth", async () => {
    const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const stanox = `X${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await seedVirtualCurrentState(stanox, trustId, "3C00");

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/virtual-berths/${stanox}/current-run`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NO_PUBLIC_DETAIL");
  });

  it("gives an anonymous request the reduced shape on a solid (matched) virtual berth", async () => {
    const scheduleId = await seedSchedule();
    const trustId = await seedActivation(scheduleId);
    const stanox = `Y${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await seedVirtualCurrentState(stanox, trustId, "4D00");

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/virtual-berths/${stanox}/current-run`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.matchStatus).toBe("matched");
    expect(body).not.toHaveProperty("matchBasis");
    expect(body).not.toHaveProperty("candidateSchedules");
  });
});
