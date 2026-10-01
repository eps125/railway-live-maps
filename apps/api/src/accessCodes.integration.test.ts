import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, createUser, setSiteSetting } from "@railway/database";
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

async function publishMinimalMap(
  slug: string,
  visibility: "public" | "restricted",
): Promise<string> {
  const mapId = (
    await pool.query<{ id: string }>(
      `insert into map (slug, name, visibility) values ($1, $1, $2) returning id::text`,
      [slug, visibility],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into map_version (map_id, version_number, canonical_document, compiled_runtime_bundle,
                              effective_from, published_by, schema_version, checksum)
     values ($1, 1, '{}', '{}', '1970-01-01', 'test', 1, $2)`,
    [mapId, randomUUID()],
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

async function createCode(payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/access-codes",
    headers: { cookie: adminCookie },
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; code: string; status: string };
}

async function redeem(code: string, remoteAddress = "203.0.113.10") {
  return app.inject({
    method: "POST",
    url: "/api/v1/access/redeem",
    payload: { code },
    remoteAddress,
  });
}

async function setMode(mode: "open" | "code_required") {
  const response = await app.inject({
    method: "PATCH",
    url: "/api/v1/admin/settings",
    headers: { cookie: adminCookie },
    payload: { site_access_mode: mode },
  });
  expect(response.statusCode).toBe(200);
}

const publicSlug = `code-public-${suffix}`;
const restrictedSlug = `code-restricted-${suffix}`;
let restrictedMapId: string;

/**
 * Milestone 84 (docs/adr/0018 §6): access codes end to end through the real server — entering a
 * code, the code-required site mode, maps-only codes, use limits, expiry, revocation, changing a
 * single use, the activity log and its flags.
 */
describe("access codes (integration)", () => {
  beforeAll(async () => {
    const built = await buildServer(testConfig());
    app = built.app;
    close = built.close;
    const admin = `codes-admin-${suffix}`;
    await createUser(pool, { username: admin, password: PASSWORD, role: "admin" });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: admin, password: PASSWORD },
    });
    adminCookie = cookieFrom(login, "rlm_session");
    await publishMinimalMap(publicSlug, "public");
    restrictedMapId = await publishMinimalMap(restrictedSlug, "restricted");
  });

  afterAll(async () => {
    // Never leave the shared test database asking for codes.
    await setSiteSetting(pool, "site_access_mode", "open", "test");
    await close();
    await pool.end();
  });

  it("an open site needs no code, and status says so", async () => {
    const status = await app.inject({ method: "GET", url: "/api/v1/access/status" });
    expect(status.json()).toMatchObject({ mode: "open", access: "none", allowed: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/maps" })).statusCode).toBe(200);
  });

  it("a code-required site refuses a guest everywhere but login, access and health", async () => {
    await setMode("code_required");
    try {
      for (const url of [
        "/api/v1/maps",
        `/api/v1/maps/${publicSlug}/definition`,
        "/api/v1/td/areas",
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("ACCESS_CODE_REQUIRED");
      }
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/access/status" })).json(),
      ).toMatchObject({ mode: "code_required", allowed: false });
      // Staff are never asked.
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/maps", headers: { cookie: adminCookie } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await setMode("open");
    }
  });

  it("a whole-site code lets a guest in for its access period, and is counted", async () => {
    const created = await createCode({
      label: `Site code ${suffix}`,
      scope: "site",
      maxUses: null,
      accessSeconds: 3600,
    });
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    await setMode("code_required");
    try {
      const entered = await redeem(created.code.toLowerCase().replace("-", " "));
      expect(entered.statusCode).toBe(200);
      const status = entered.json();
      expect(status).toMatchObject({ access: "code", allowed: true, scope: "site" });
      const expiresIn = new Date(status.expiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(3500_000);
      expect(expiresIn).toBeLessThanOrEqual(3600_000);

      const cookie = cookieFrom(entered, "rlm_access");
      const list = await app.inject({ method: "GET", url: "/api/v1/maps", headers: { cookie } });
      expect(list.statusCode).toBe(200);
      const slugs = list.json().maps.map((m: { slug: string }) => m.slug);
      expect(slugs).toContain(publicSlug);
      expect(slugs).not.toContain(restrictedSlug);

      // Seen from a second address in the same hour: flagged.
      await app.inject({
        method: "GET",
        url: "/api/v1/maps",
        headers: { cookie },
        remoteAddress: "198.51.100.20",
      });
      const detail = (
        await app.inject({
          method: "GET",
          url: `/api/v1/admin/access-codes/${created.id}`,
          headers: { cookie: adminCookie },
        })
      ).json();
      expect(detail.useCount).toBe(1);
      expect(detail.grants).toHaveLength(1);
      expect(detail.grants[0].firstIp).toBe("203.0.113.10");
      expect(detail.grants[0].requestCount).toBeGreaterThanOrEqual(2);
      expect(detail.grants[0].flags).toContain("simultaneous_ips");
    } finally {
      await setMode("open");
    }
  });

  it("a maps-only code shows its maps — restricted ones too — and, when required, only those", async () => {
    const created = await createCode({
      label: `Maps code ${suffix}`,
      scope: "maps",
      mapIds: [restrictedMapId],
      maxUses: 5,
      accessSeconds: 3600,
    });
    const cookie = cookieFrom(await redeem(created.code), "rlm_access");

    // Open site: public maps plus the code's restricted map.
    const open = await app.inject({ method: "GET", url: "/api/v1/maps", headers: { cookie } });
    const openSlugs = open.json().maps.map((m: { slug: string }) => m.slug);
    expect(openSlugs).toEqual(expect.arrayContaining([publicSlug, restrictedSlug]));
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/maps/${restrictedSlug}/definition`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    await setMode("code_required");
    try {
      const closed = await app.inject({ method: "GET", url: "/api/v1/maps", headers: { cookie } });
      expect(closed.json().maps.map((m: { slug: string }) => m.slug)).toEqual([restrictedSlug]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/maps/${publicSlug}/definition`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      const status = (
        await app.inject({ method: "GET", url: "/api/v1/access/status", headers: { cookie } })
      ).json();
      expect(status.maps).toEqual([{ slug: restrictedSlug, name: restrictedSlug }]);
    } finally {
      await setMode("open");
    }
  });

  it("a code stops at its use limit, its last-entry date, and when revoked", async () => {
    const once = await createCode({
      label: `Once ${suffix}`,
      scope: "site",
      maxUses: 1,
      accessSeconds: 600,
    });
    expect((await redeem(once.code)).statusCode).toBe(200);
    const second = await redeem(once.code);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.details.reason).toBe("used_up");

    const lapsed = await createCode({
      label: `Lapsed ${suffix}`,
      scope: "site",
      maxUses: null,
      accessSeconds: 600,
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await redeem(lapsed.code)).json().error.details.reason).toBe("expired");

    expect((await redeem("NOSUCHCODE")).json().error.details.reason).toBe("unknown");

    const revoked = await createCode({
      label: `Revoked ${suffix}`,
      scope: "site",
      maxUses: null,
      accessSeconds: 3600,
    });
    const cookie = cookieFrom(await redeem(revoked.code), "rlm_access");
    await app.inject({
      method: "POST",
      url: `/api/v1/admin/access-codes/${revoked.id}/revoke`,
      headers: { cookie: adminCookie },
    });
    expect((await redeem(revoked.code)).json().error.details.reason).toBe("revoked");
    await setMode("code_required");
    try {
      // Revoking ended the use already made.
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/maps", headers: { cookie } })).statusCode,
      ).toBe(401);
    } finally {
      await setMode("open");
    }
  });

  it("an admin can end or extend one use after it was entered", async () => {
    const created = await createCode({
      label: `Adjust ${suffix}`,
      scope: "site",
      maxUses: null,
      accessSeconds: 600,
    });
    const cookie = cookieFrom(await redeem(created.code), "rlm_access");
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/v1/admin/access-codes/${created.id}`,
        headers: { cookie: adminCookie },
      })
    ).json();
    const grantId = detail.grants[0].id as string;

    const later = new Date(Date.now() + 5 * 86400_000).toISOString();
    await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/access-grants/${grantId}`,
      headers: { cookie: adminCookie },
      payload: { expiresAt: later },
    });
    const status = (
      await app.inject({ method: "GET", url: "/api/v1/access/status", headers: { cookie } })
    ).json();
    expect(status.expiresAt).toBe(later);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/access-grants/${grantId}`,
      headers: { cookie: adminCookie },
      payload: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const ended = (
      await app.inject({ method: "GET", url: "/api/v1/access/status", headers: { cookie } })
    ).json();
    expect(ended.access).toBe("none");
  });

  it("validates codes: custom text, duplicates, maps-only without maps, limits below uses", async () => {
    const custom = await createCode({
      label: `Custom ${suffix}`,
      code: `open-day-${suffix}`.slice(0, 20),
      scope: "site",
      maxUses: 3,
      accessSeconds: 3600,
    });
    expect(custom.code).toBe(`open-day-${suffix}`.slice(0, 20));
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/access-codes",
      headers: { cookie: adminCookie },
      payload: {
        label: "dup",
        code: `OPEN DAY ${suffix}`.slice(0, 20).toUpperCase(),
        scope: "site",
        maxUses: null,
        accessSeconds: 3600,
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const noMaps = await app.inject({
      method: "POST",
      url: "/api/v1/admin/access-codes",
      headers: { cookie: adminCookie },
      payload: { label: "x", scope: "maps", mapIds: [], maxUses: null, accessSeconds: 3600 },
    });
    expect(noMaps.statusCode).toBe(400);

    await redeem(custom.code);
    await redeem(custom.code);
    const tooLow = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/access-codes/${custom.id}`,
      headers: { cookie: adminCookie },
      payload: { maxUses: 1 },
    });
    expect(tooLow.statusCode).toBe(400);
  });

  it("every code change is in the audit log", async () => {
    const log = (
      await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit-log?action=access.",
        headers: { cookie: adminCookie },
      })
    ).json();
    const actions = new Set(log.entries.map((e: { action: string }) => e.action));
    for (const action of ["access.code.create", "access.code.revoke", "access.grant.update"]) {
      expect(actions).toContain(action);
    }
  });
});
