import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, createUser, findUserTypeByName } from "@railway/database";
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
const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
const PASSWORD = "correct-horse-battery";

type App = Awaited<ReturnType<typeof buildServer>>["app"];
let app: App;
let close: () => Promise<void>;
let adminCookie: string;

const mapSlug = `perm-map-${suffix}`;

/** A published map whose bundle has one numbered signal, so signal-number stripping shows. */
async function publishMapWithSignal(slug: string): Promise<string> {
  const mapId = (
    await pool.query<{ id: string }>(
      `insert into map (slug, name, visibility) values ($1, $1, 'public') returning id::text`,
      [slug],
    )
  ).rows[0]!.id;
  const bundle = {
    elementsById: {
      s1: { id: "s1", layerId: "l1", type: "signal", x: 0, y: 0, label: "PX123" },
    },
    berthBindingIndex: {},
    sBitBindingIndex: {},
  };
  await pool.query(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
                              effective_from, published_by, schema_version, checksum)
     values ($1, 1, '{}', $2, '1970-01-01', 'test', 1, $3)`,
    [mapId, JSON.stringify(bundle), randomUUID()],
  );
  return mapId;
}

function cookieFrom(response: { headers: Record<string, unknown> }, name: string): string {
  const setCookie = response.headers["set-cookie"];
  const all = (Array.isArray(setCookie) ? setCookie : [setCookie]) as string[];
  const found = all.find((c) => c?.startsWith(`${name}=`));
  if (!found) throw new Error(`no ${name} cookie set`);
  return found.split(";")[0]!;
}

async function typeIdOf(name: string): Promise<string> {
  return (await findUserTypeByName(pool, name))!.id;
}

async function userCookie(typeName: string): Promise<string> {
  const username = `perm-${typeName.replace(/\W+/g, "-").toLowerCase()}-${randomUUID()}`;
  await createUser(pool, { username, password: PASSWORD, userTypeId: await typeIdOf(typeName) });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORD },
  });
  return cookieFrom(login, "rlm_session");
}

async function codeCookie(payload: Record<string, unknown>): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/access-codes",
    headers: { cookie: adminCookie },
    payload: { label: `perm ${suffix}`, maxUses: null, accessSeconds: 3600, ...payload },
  });
  expect(created.statusCode).toBe(201);
  const redeemed = await app.inject({
    method: "POST",
    url: "/api/v1/access/redeem",
    payload: { code: created.json().code },
  });
  return cookieFrom(redeemed, "rlm_access");
}

async function status(url: string, cookie?: string, method: "GET" | "POST" = "GET") {
  const response = await app.inject({
    method,
    url,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  return response.statusCode;
}

/**
 * Milestone 99 (docs/adr/0022): user types, the permission matrix and access codes that grant
 * them, end to end through the real server — every check is the API's own, not the web app's.
 */
describe("user types and permissions (integration)", () => {
  beforeAll(async () => {
    const built = await buildServer(testConfig());
    app = built.app;
    close = built.close;
    adminCookie = await userCookie("Admin");
    await publishMapWithSignal(mapSlug);
  });

  afterAll(async () => {
    await close();
    await pool.end();
  });

  it("lists the six seeded types with the registry, and reports a user's permissions", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/user-types",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const names = body.types.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "No user (public)",
        "Basic User",
        "Enhanced User",
        "Editor",
        "Enhanced Editor",
        "Admin",
      ]),
    );
    expect(body.permissions.some((p: { key: string }) => p.key === "popup.trust")).toBe(true);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: await userCookie("Editor") },
    });
    expect(me.json().userType.name).toBe("Editor");
    expect(me.json().permissions).toContain("maps.edit");
    expect(me.json().permissions).not.toContain("maps.publish");
  });

  it("strips signal numbers unless the viewer has map.signal_numbers", async () => {
    const guest = await app.inject({ method: "GET", url: `/api/v1/maps/${mapSlug}/definition` });
    expect(guest.json().definition.elementsById.s1.label).toBeUndefined();
    const editor = await app.inject({
      method: "GET",
      url: `/api/v1/maps/${mapSlug}/definition`,
      headers: { cookie: await userCookie("Editor") },
    });
    expect(editor.json().definition.elementsById.s1.label).toBe("PX123");
  });

  it("gates the editor, publishing, the tools and the admin pages by permission", async () => {
    const editor = await userCookie("Editor");
    const enhanced = await userCookie("Enhanced Editor");
    const draft = `/api/v1/editor/maps/${mapSlug}/draft`;
    expect(await status(draft, editor)).toBe(200);
    expect(await status(`/api/v1/editor/maps/${mapSlug}/publish`, editor, "POST")).toBe(403);
    expect(await status("/api/v1/admin/td-boundaries", editor)).toBe(403);
    expect(await status("/api/v1/admin/td-boundaries", enhanced)).toBe(200);
    expect(await status("/api/v1/admin/users", enhanced)).toBe(403);
    expect(await status("/api/v1/admin/user-types", enhanced)).toBe(403);
    expect(await status("/api/v1/admin/settings", enhanced)).toBe(403);
    expect(await status("/api/v1/admin/audit-log", enhanced)).toBe(403);
    expect(await status("/api/v1/admin/access-codes", enhanced)).toBe(403);
    // Map management is Admin only (owner, 2026-10-28).
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      headers: { cookie: enhanced },
      payload: { slug: `nope-${suffix}`, name: "x" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("applies a matrix change on the next request", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/user-types",
      headers: { cookie: adminCookie },
      payload: { name: `Viewer ${suffix}`, permissions: ["site.view", "maps.view_public"] },
    });
    expect(created.statusCode).toBe(201);
    const typeId = created.json().id as string;
    const username = `perm-viewer-${suffix}`;
    await createUser(pool, { username, password: PASSWORD, userTypeId: typeId });
    const cookie = cookieFrom(
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password: PASSWORD },
      }),
      "rlm_session",
    );
    // Signal numbers: not held by this type (nor by the public type in seeded data).
    const label = async (): Promise<unknown> =>
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${mapSlug}/definition`,
          headers: { cookie },
        })
      ).json().definition.elementsById.s1.label;
    expect(await label()).toBeUndefined();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/user-types/${typeId}`,
      headers: { cookie: adminCookie },
      payload: { permissions: ["site.view", "maps.view_public", "map.signal_numbers"] },
    });
    expect(patched.statusCode).toBe(200);
    expect(await label()).toBe("PX123");

    // In use: cannot be deleted.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/user-types/${typeId}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("USER_TYPE_IN_USE");
  });

  it("never changes the Admin type", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/user-types/${await typeIdOf("Admin")}`,
      headers: { cookie: adminCookie },
      payload: { permissions: [] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SYSTEM_USER_TYPE");
  });

  it("a custom code gives exactly its permissions, editor ones included", async () => {
    const viewOnly = await codeCookie({
      grantKind: "custom",
      permissions: ["site.view", "maps.view_public"],
      mapLimit: "none",
    });
    expect(await status(`/api/v1/maps/${mapSlug}/definition`, viewOnly)).toBe(200);
    expect(await status(`/api/v1/editor/maps/${mapSlug}/draft`, viewOnly)).toBe(403);

    const withEditor = await codeCookie({
      grantKind: "custom",
      permissions: ["site.view", "maps.view_public", "editor.view", "maps.edit"],
      mapLimit: "none",
    });
    expect(await status(`/api/v1/editor/maps/${mapSlug}/draft`, withEditor)).toBe(200);
    expect(await status(`/api/v1/editor/maps/${mapSlug}/publish`, withEditor, "POST")).toBe(403);
    expect(await status("/api/v1/admin/users", withEditor)).toBe(403);
  });

  it("refuses a code that would give an admin permission or a built-in type", async () => {
    for (const payload of [
      { grantKind: "custom", permissions: ["site.view", "admin.users"], mapLimit: "none" },
      { grantKind: "user_type", userTypeId: await typeIdOf("Admin"), mapLimit: "none" },
      { grantKind: "user_type", userTypeId: await typeIdOf("No user (public)"), mapLimit: "none" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/access-codes",
        headers: { cookie: adminCookie },
        payload: { label: `bad ${suffix}`, maxUses: null, accessSeconds: 3600, ...payload },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
