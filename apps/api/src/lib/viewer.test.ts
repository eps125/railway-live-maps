import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  mapVisibilityHook,
  mapVisibilitySql,
  siteAccessHook,
  viewerMayUseSite,
  type Viewer,
} from "./viewer.js";
import type { SiteAccess } from "./siteAccess.js";

const GUEST: Viewer = { user: null, grant: null, siteMode: "open" };
const EDITOR: Viewer = {
  user: { id: "7", username: "ed", role: "editor" },
  grant: null,
  siteMode: "open",
};
const ADMIN: Viewer = {
  user: { id: "1", username: "boss", role: "admin" },
  grant: null,
  siteMode: "open",
};
const EXPIRES = new Date("2030-01-01T00:00:00Z");
const SITE_GRANT = { id: "40", codeId: "4", scope: "site" as const, expiresAt: EXPIRES };
const MAPS_GRANT = { id: "50", codeId: "5", scope: "maps" as const, expiresAt: EXPIRES };

describe("mapVisibilitySql", () => {
  it("a guest sees public maps only", () => {
    expect(mapVisibilitySql(GUEST, "m", 3)).toEqual({ sql: "m.visibility = 'public'", params: [] });
  });

  it("a user also sees restricted maps shared with one of their groups", () => {
    const { sql, params } = mapVisibilitySql(EDITOR, "x", 4);
    expect(sql).toContain("x.visibility = 'public' or exists");
    expect(sql).toContain("mvg.map_id = x.id and aug.user_id = $4::bigint");
    expect(params).toEqual(["7"]);
  });

  it("an admin sees every map", () => {
    expect(mapVisibilitySql(ADMIN, "m", 1)).toEqual({ sql: "true", params: [] });
  });

  it("Milestone 84: a site-wide code sees public maps, like any guest", () => {
    expect(mapVisibilitySql({ ...GUEST, grant: SITE_GRANT }, "m", 1)).toEqual({
      sql: "m.visibility = 'public'",
      params: [],
    });
  });

  it("Milestone 84: a code naming maps adds them (restricted too) on an open site", () => {
    const { sql, params } = mapVisibilitySql({ ...GUEST, grant: MAPS_GRANT }, "m", 2);
    expect(sql).toContain("m.visibility = 'public' or exists");
    expect(sql).toContain("acm.code_id = $2::bigint");
    expect(params).toEqual(["5"]);
  });

  it("Milestone 84: while the site needs a code, a code naming maps gives exactly those maps", () => {
    const { sql, params } = mapVisibilitySql(
      { ...GUEST, grant: MAPS_GRANT, siteMode: "code_required" },
      "m",
      1,
    );
    expect(sql).not.toContain("visibility = 'public'");
    expect(sql).toContain("acm.code_id = $1::bigint");
    expect(params).toEqual(["5"]);
  });

  it("Milestone 84: a user with a code gets their groups' maps and the code's maps", () => {
    const { sql, params } = mapVisibilitySql({ ...EDITOR, grant: MAPS_GRANT }, "m", 3);
    expect(sql).toContain("aug.user_id = $3::bigint");
    expect(sql).toContain("acm.code_id = $4::bigint");
    expect(params).toEqual(["7", "5"]);
  });
});

describe("viewerMayUseSite", () => {
  it("lets anyone in on an open site, and only users or code holders when a code is needed", () => {
    expect(viewerMayUseSite(GUEST)).toBe(true);
    const closed = { ...GUEST, siteMode: "code_required" as const };
    expect(viewerMayUseSite(closed)).toBe(false);
    expect(viewerMayUseSite({ ...closed, grant: SITE_GRANT })).toBe(true);
    expect(viewerMayUseSite({ ...EDITOR, siteMode: "code_required" })).toBe(true);
  });
});

function fakeRedis(sessions: Record<string, unknown>): Redis {
  return {
    get: async (key: string) => {
      const token = key.replace(/^session:/, "");
      return sessions[token] ? JSON.stringify(sessions[token]) : null;
    },
    expire: async () => 1,
  } as unknown as Redis;
}

/** A map table of slug → { visible-to-guest, visible-to-user-7 }. */
function fakePool(maps: Record<string, { guest: boolean; user: boolean }>): Pool {
  return {
    query: async (text: string, values: unknown[]) => {
      const map = maps[values[0] as string];
      if (!map) return { rows: [] };
      const isUser = values.length > 1;
      const visible = text.includes("select true") ? true : isUser ? map.user : map.guest;
      return { rows: [{ visible }] };
    },
  } as unknown as Pool;
}

async function buildApp(pool: Pool, redis: Redis) {
  const app = Fastify();
  await app.register(fastifyCookie);
  app.decorateRequest("authSession", null);
  app.decorateRequest("viewer", null);
  app.addHook("preHandler", mapVisibilityHook({ pool, redis, sessionTtlSeconds: 60 }));
  app.get<{ Params: { slug: string } }>("/maps/:slug", async (request) => ({
    slug: request.params.slug,
    viewer: request.viewer,
  }));
  app.get("/list", async (request) => ({ viewer: request.viewer }));
  return app;
}

describe("mapVisibilityHook", () => {
  const pool = fakePool({
    lancaster: { guest: true, user: true },
    "staff-map": { guest: false, user: true },
    "admin-map": { guest: false, user: false },
  });
  const redis = fakeRedis({
    "editor-token": { userId: "7", username: "ed", role: "editor" },
    "admin-token": { userId: "1", username: "boss", role: "admin" },
  });

  it("answers 404 MAP_NOT_FOUND for a map the viewer may not see, never 403", async () => {
    const app = await buildApp(pool, redis);
    const response = await app.inject({ method: "GET", url: "/maps/staff-map" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MAP_NOT_FOUND");
  });

  it("lets a group member through to a restricted map, and an admin through to any map", async () => {
    const app = await buildApp(pool, redis);
    const asEditor = await app.inject({
      method: "GET",
      url: "/maps/staff-map",
      cookies: { rlm_session: "editor-token" },
    });
    expect(asEditor.statusCode).toBe(200);
    expect(asEditor.json().viewer).toEqual({
      user: { id: "7", username: "ed", role: "editor" },
      grant: null,
      siteMode: "open",
    });

    const editorToAdminMap = await app.inject({
      method: "GET",
      url: "/maps/admin-map",
      cookies: { rlm_session: "editor-token" },
    });
    expect(editorToAdminMap.statusCode).toBe(404);

    const asAdmin = await app.inject({
      method: "GET",
      url: "/maps/admin-map",
      cookies: { rlm_session: "admin-token" },
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it("passes a public map and an unknown slug through (the route decides not-found)", async () => {
    const app = await buildApp(pool, redis);
    expect((await app.inject({ method: "GET", url: "/maps/lancaster" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/maps/nowhere" })).statusCode).toBe(200);
  });

  it("resolves the viewer on routes without a slug, and treats an expired session as a guest", async () => {
    const app = await buildApp(pool, redis);
    const response = await app.inject({
      method: "GET",
      url: "/list",
      cookies: { rlm_session: "expired-token" },
    });
    expect(response.json().viewer).toEqual({ user: null, grant: null, siteMode: "open" });
  });
});

function fakeSiteAccess(
  mode: "open" | "code_required",
  grants: Record<string, typeof SITE_GRANT>,
): SiteAccess & { noted: string[] } {
  const noted: string[] = [];
  return {
    noted,
    siteMode: async () => mode,
    grantForToken: async (token) => {
      const grant = token ? grants[token] : undefined;
      return grant ? { ...grant, codeLabel: "test" } : null;
    },
    noteActivity: (grantId, ip) => {
      noted.push(`${grantId}@${ip}`);
    },
    invalidate: () => undefined,
    flush: async () => undefined,
    close: async () => undefined,
  };
}

describe("siteAccessHook (Milestone 84)", () => {
  const token = "a".repeat(64);

  async function gatedApp(siteAccess: SiteAccess) {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.decorateRequest("authSession", null);
    app.decorateRequest("viewer", null);
    const redis = fakeRedis({ "editor-token": { userId: "7", username: "ed", role: "editor" } });
    app.addHook(
      "onRequest",
      siteAccessHook({ redis, sessionTtlSeconds: 60, siteAccess: siteAccess }),
    );
    for (const url of [
      "/api/v1/maps",
      "/api/v1/access/status",
      "/api/v1/auth/me",
      "/health/live",
    ]) {
      app.get(url, async () => ({ ok: true }));
    }
    return app;
  }

  it("asks a guest without a code for one, on every API route but login, access and health", async () => {
    const app = await gatedApp(fakeSiteAccess("code_required", {}));
    const blocked = await app.inject({ method: "GET", url: "/api/v1/maps" });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe("ACCESS_CODE_REQUIRED");
    for (const url of ["/api/v1/access/status", "/api/v1/auth/me", "/health/live"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
  });

  it("lets in a code holder (counting the request) and a logged-in user", async () => {
    const siteAccess = fakeSiteAccess("code_required", { [token]: SITE_GRANT });
    const app = await gatedApp(siteAccess);
    const withCode = await app.inject({
      method: "GET",
      url: "/api/v1/maps",
      cookies: { rlm_access: token },
      remoteAddress: "203.0.113.9",
    });
    expect(withCode.statusCode).toBe(200);
    expect(siteAccess.noted).toEqual(["40@203.0.113.9"]);

    const asUser = await app.inject({
      method: "GET",
      url: "/api/v1/maps",
      cookies: { rlm_session: "editor-token" },
    });
    expect(asUser.statusCode).toBe(200);
  });

  it("does nothing on an open site", async () => {
    const app = await gatedApp(fakeSiteAccess("open", {}));
    expect((await app.inject({ method: "GET", url: "/api/v1/maps" })).statusCode).toBe(200);
  });
});
