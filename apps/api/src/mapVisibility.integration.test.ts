import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, createUser, recordAudit } from "@railway/database";
import { buildServer } from "./server.js";
import type { Config } from "./config.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

function testConfig(): Config {
  return {
    APP_ENV: "test",
    PORT: 0,
    DATABASE_URL: requireEnv("DATABASE_URL"),
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    DISPLAY_TIMEZONE: "Europe/London",
    SESSION_TTL_SECONDS: 3600,
    COOKIE_SECURE: false,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: 50,
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: 900,
    LIVE_WS_REDIS_PUBSUB_ENABLED: false,
    LIVE_WS_POLL_INTERVAL_MS: 1000,
    LIVE_WS_HEARTBEAT_INTERVAL_MS: 15000,
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const PASSWORD = "correct-horse-battery";
const suffix = randomUUID().replace(/-/g, "").slice(0, 8);

type App = Awaited<ReturnType<typeof buildServer>>["app"];
let app: App;
let close: () => Promise<void>;

async function login(username: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return cookie!.split(";")[0]!;
}

/** A map with one effective published version (an empty bundle is enough for these routes). */
async function publishMinimalMap(slug: string): Promise<string> {
  const mapId = (
    await pool.query<{ id: string }>(`insert into map (slug, name) values ($1, $1) returning id`, [
      slug,
    ])
  ).rows[0]!.id;
  await pool.query(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
                              effective_from, published_by, schema_version, checksum)
     values ($1, 1, '{}', '{}', '1970-01-01', 'test', 1, $2)`,
    [mapId, randomUUID()],
  );
  return mapId;
}

const staffMap = `staff-map-${suffix}`;
const names = {
  admin: `vis-admin-${suffix}`,
  member: `vis-member-${suffix}`,
  outsider: `vis-outsider-${suffix}`,
};
let groupId: string;
let adminCookie: string;
let memberCookie: string;
let outsiderCookie: string;

/**
 * Milestone 83 (docs/adr/0018): map visibility end to end through the real server — guest,
 * group member, editor outside the group, and admin — plus the admin routes that change it and
 * the audit log they write.
 */
describe("map visibility, groups and audit log (integration)", () => {
  beforeAll(async () => {
    const built = await buildServer(testConfig());
    app = built.app;
    close = built.close;

    await createUser(pool, { username: names.admin, password: PASSWORD, role: "admin" });
    const member = await createUser(pool, {
      username: names.member,
      password: PASSWORD,
      role: "editor",
    });
    await createUser(pool, { username: names.outsider, password: PASSWORD, role: "editor" });

    groupId = (
      await pool.query<{ id: string }>(
        `insert into user_group (name) values ($1) returning id::text`,
        [`Signallers ${suffix}`],
      )
    ).rows[0]!.id;
    await pool.query(`insert into app_user_group (user_id, group_id) values ($1, $2)`, [
      member.id,
      groupId,
    ]);

    const mapId = await publishMinimalMap(staffMap);
    await pool.query(`update map set visibility = 'restricted' where id = $1`, [mapId]);
    await pool.query(`insert into map_visibility_group (map_id, group_id) values ($1, $2)`, [
      mapId,
      groupId,
    ]);

    adminCookie = await login(names.admin);
    memberCookie = await login(names.member);
    outsiderCookie = await login(names.outsider);
  });

  afterAll(async () => {
    await close();
    await pool.end();
  });

  function listed(body: { maps: { slug: string }[] }): boolean {
    return body.maps.some((map) => map.slug === staffMap);
  }

  it("hides a restricted map from a guest: not listed, and 404 like a missing map", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/maps" });
    expect(listed(list.json())).toBe(false);

    for (const path of ["definition", "state", "delays"]) {
      const response = await app.inject({ method: "GET", url: `/api/v1/maps/${staffMap}/${path}` });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("MAP_NOT_FOUND");
    }
  });

  it("shows it to a member of a group it is shared with", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/maps",
      headers: { cookie: memberCookie },
    });
    expect(listed(list.json())).toBe(true);
    expect(list.json().maps.find((m: { slug: string }) => m.slug === staffMap).visibility).toBe(
      "restricted",
    );

    const definition = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${staffMap}/definition`,
      headers: { cookie: memberCookie },
    });
    expect(definition.statusCode).toBe(200);
  });

  it("hides it from an editor outside the group, in the editor too", async () => {
    const definition = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${staffMap}/definition`,
      headers: { cookie: outsiderCookie },
    });
    expect(definition.statusCode).toBe(404);

    const draft = await app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${staffMap}/draft`,
      headers: { cookie: outsiderCookie },
    });
    expect(draft.statusCode).toBe(404);

    const editorList = await app.inject({
      method: "GET",
      url: "/api/v1/editor/maps",
      headers: { cookie: outsiderCookie },
    });
    expect(listed(editorList.json())).toBe(false);

    const memberDraft = await app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${staffMap}/draft`,
      headers: { cookie: memberCookie },
    });
    expect(memberDraft.statusCode).toBe(200);
  });

  it("an admin sees it everywhere, makes it public (audited), then admins-only again", async () => {
    const editorList = await app.inject({
      method: "GET",
      url: "/api/v1/editor/maps",
      headers: { cookie: adminCookie },
    });
    const entry = editorList.json().maps.find((m: { slug: string }) => m.slug === staffMap);
    expect(entry).toMatchObject({
      visibility: "restricted",
      groupIds: [groupId],
      publishedVersion: 1,
    });

    const makePublic = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${staffMap}`,
      headers: { cookie: adminCookie },
      payload: { visibility: "public", groupIds: [] },
    });
    expect(makePublic.statusCode).toBe(200);
    expect(listed((await app.inject({ method: "GET", url: "/api/v1/maps" })).json())).toBe(true);

    const adminsOnly = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${staffMap}`,
      headers: { cookie: adminCookie },
      payload: { visibility: "restricted" },
    });
    expect(adminsOnly.json()).toMatchObject({ visibility: "restricted", groupIds: [] });
    // No groups left: the member loses it too.
    const asMember = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${staffMap}/definition`,
      headers: { cookie: memberCookie },
    });
    expect(asMember.statusCode).toBe(404);

    const log = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit-log?action=map.settings&user=${names.admin}`,
      headers: { cookie: adminCookie },
    });
    const settingsEntries = log
      .json()
      .entries.filter((e: { details: { slug?: string } }) => e.details.slug === staffMap);
    expect(settingsEntries).toHaveLength(2);
    expect(settingsEntries[1].details.before.visibility).toBe("restricted");
    expect(settingsEntries[1].details.after.visibility).toBe("public");
    expect(settingsEntries[0].actorUsername).toBe(names.admin);
  });

  it("rejects an unknown group or region in map settings", async () => {
    const badGroup = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${staffMap}`,
      headers: { cookie: adminCookie },
      payload: { groupIds: ["999999999"] },
    });
    expect(badGroup.statusCode).toBe(400);
    const badRegion = await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${staffMap}`,
      headers: { cookie: adminCookie },
      payload: { regionId: "999999999" },
    });
    expect(badRegion.statusCode).toBe(400);
  });

  it("groups: create, add a user, rename, delete — the user's groups follow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/groups",
      headers: { cookie: adminCookie },
      payload: { name: `Guests ${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    const newGroupId = created.json().id as string;

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/groups",
      headers: { cookie: adminCookie },
      payload: { name: `guests ${suffix}` },
    });
    expect(duplicate.statusCode).toBe(409);

    const users = (
      await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { cookie: adminCookie },
      })
    ).json().users as { id: string; username: string; groupIds: string[] }[];
    const outsider = users.find((u) => u.username === names.outsider)!;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${outsider.id}`,
      headers: { cookie: adminCookie },
      payload: { groupIds: [newGroupId] },
    });
    expect(patched.json().groupIds).toEqual([newGroupId]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/groups/${newGroupId}`,
      headers: { cookie: adminCookie },
      payload: { name: `Visitors ${suffix}` },
    });
    expect(renamed.json()).toMatchObject({ name: `Visitors ${suffix}`, memberCount: 1 });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/groups/${newGroupId}`,
      headers: { cookie: adminCookie },
    });
    expect(deleted.statusCode).toBe(204);
    const after = (
      await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { cookie: adminCookie },
      })
    ).json().users as { username: string; groupIds: string[] }[];
    expect(after.find((u) => u.username === names.outsider)!.groupIds).toEqual([]);
  });

  it("regions: create, reorder, assign to a map; the public list carries it and the setting", async () => {
    const make = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/regions",
          headers: { cookie: adminCookie },
          payload: { name },
        })
      ).json().id as string;
    const north = await make(`North ${suffix}`);
    const south = await make(`South ${suffix}`);

    const all = (
      await app.inject({
        method: "GET",
        url: "/api/v1/admin/regions",
        headers: { cookie: adminCookie },
      })
    ).json().regions as { id: string }[];
    const order = all.map((r) => r.id).filter((id) => id !== south);
    order.unshift(south);
    const reordered = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/regions/order",
      headers: { cookie: adminCookie },
      payload: { ids: order },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().regions[0].id).toBe(south);

    const incomplete = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/regions/order",
      headers: { cookie: adminCookie },
      payload: { ids: [south] },
    });
    expect(incomplete.statusCode).toBe(400);

    const publicSlug = `region-map-${suffix}`;
    await publishMinimalMap(publicSlug);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${publicSlug}`,
      headers: { cookie: adminCookie },
      payload: { regionId: north, description: "A test map" },
    });

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: { cookie: adminCookie },
      payload: { map_list_region_grouping: true },
    });
    expect(settings.json().settings.map_list_region_grouping).toBe(true);
    const badSetting = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: { cookie: adminCookie },
      payload: { map_list_region_grouping: "yes" },
    });
    expect(badSetting.statusCode).toBe(400);

    const list = (await app.inject({ method: "GET", url: "/api/v1/maps" })).json();
    expect(list.regionGrouping).toBe(true);
    expect(list.maps.find((m: { slug: string }) => m.slug === publicSlug)).toMatchObject({
      description: "A test map",
      region: { id: north, name: `North ${suffix}` },
    });

    // Deleting the region leaves the map region-less, not deleted.
    await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/regions/${north}`,
      headers: { cookie: adminCookie },
    });
    const afterDelete = (await app.inject({ method: "GET", url: "/api/v1/maps" })).json();
    expect(afterDelete.maps.find((m: { slug: string }) => m.slug === publicSlug).region).toBeNull();

    await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: { cookie: adminCookie },
      payload: { map_list_region_grouping: false },
    });
  });

  it("the audit log cannot be edited or deleted", async () => {
    await recordAudit(pool, {
      actor: { userId: null, username: "test" },
      action: `test.append-only-${suffix}`,
    });
    await expect(
      pool.query(`update admin_audit_log set action = 'x' where action = $1`, [
        `test.append-only-${suffix}`,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`delete from admin_audit_log where action = $1`, [`test.append-only-${suffix}`]),
    ).rejects.toThrow(/append-only/);
  });

  it("the audit log is admin-only", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-log",
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(403);
  });
});
