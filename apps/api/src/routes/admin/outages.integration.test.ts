import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, createUser, findUserTypeByName } from "@railway/database";
import { registerOutageRoutes } from "./outages.js";
import { appAs, viewerWith } from "../../lib/testViewers.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const gapIds: string[] = [];
let userId = "";
/** Test gaps sit 300 days back in a made-up area, so no other test's "is there a gap near now"
 * check (map quality, run lineage) can ever see them. */
const DAYS_AGO_300 = 300 * 24 * 60;

async function insertGap(minutesAgo: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into feed_gap (feed_name, td_area, detected_start, detected_end, detection_reason,
                           recoverability, affected_time_start, affected_time_end)
     values ('TD', 'Z9', now() - make_interval(mins => $1), now() - make_interval(mins => $1 - 12),
             'integration_test', 'unrecoverable',
             now() - make_interval(mins => $1), now() - make_interval(mins => $1 - 12))
     returning id::text`,
    [minutesAgo],
  );
  gapIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function buildApp() {
  const app = appAs(viewerWith(undefined, { id: userId, username: "outages", userTypeId: "0" }));
  await registerOutageRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("admin outage routes (integration)", () => {
  beforeAll(async () => {
    const admin = (await findUserTypeByName(pool, "Admin"))!;
    userId = (
      await createUser(pool, {
        username: `outages-${randomUUID()}`,
        password: "integration-test-password",
        userTypeId: admin.id,
      })
    ).id;
  });

  afterAll(async () => {
    await pool.query(`delete from feed_gap where id = any($1::bigint[])`, [gapIds]);
    await pool.query(`delete from app_user where id = $1`, [userId]);
    await pool.end();
  });

  it("lists a recorded gap, counts it unseen until the page marks it seen", async () => {
    const app = await buildApp();
    const first = await insertGap(DAYS_AGO_300 + 60);

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/outages?days=365" });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.seenThroughGapId).toBe("0");
    expect(body.outages.find((o: { id: string }) => o.id === first)).toMatchObject({
      feed: "TD",
      tdArea: "Z9",
      durationSeconds: 720,
      reason: "integration_test",
      recoverability: "unrecoverable",
    });

    const before = (
      await app.inject({ method: "GET", url: "/api/v1/admin/outages/summary" })
    ).json();
    expect(before.unseen).toBeGreaterThanOrEqual(1);

    const seen = await app.inject({
      method: "POST",
      url: "/api/v1/admin/outages/seen",
      payload: { throughGapId: first },
    });
    expect(seen.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/outages/summary" })).json().unseen,
    ).toBe(0);

    // A gap recorded later shows again; marking an older id never moves the marker back.
    const second = await insertGap(DAYS_AGO_300 + 30);
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/outages/seen",
      payload: { throughGapId: "1" },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/outages/summary" })).json().unseen,
    ).toBe(1);

    // Never past the newest gap that exists.
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/outages/seen",
      payload: { throughGapId: "999999999999" },
    });
    const { rows } = await pool.query<{ seen: string }>(
      `select seen_through_gap_id::text as seen from feed_gap_seen where user_id = $1`,
      [userId],
    );
    expect(BigInt(rows[0]!.seen)).toBe(BigInt(second));

    await app.close();
  });

  it("rejects a bad days value or a missing gap id", async () => {
    const app = await buildApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/outages?days=0" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/admin/outages/seen", payload: {} }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });
});
