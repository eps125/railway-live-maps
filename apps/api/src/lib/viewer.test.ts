import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { ActiveGrant, Permission, PermissionMatrix } from "@railway/database";
import {
  buildViewer,
  mapVisibilityHook,
  mapVisibilitySql,
  requirePermission,
  siteAccessHook,
  viewerMayUseSite,
  type Viewer,
} from "./viewer.js";
import type { SiteAccess } from "./siteAccess.js";
import { editorRoutePermission } from "./editorPermissions.js";

const BASIC: Permission[] = ["site.view", "maps.view_public", "map.playback"];

/** Types: 1 public, 2 basic, 3 group-scoped editor, 4 all-maps, 5 admin-ish. */
function matrix(publicPermissions: Permission[] = BASIC): PermissionMatrix {
  return {
    publicTypeId: "1",
    byType: new Map<string, ReadonlySet<Permission>>([
      ["1", new Set(publicPermissions)],
      ["2", new Set(BASIC)],
      ["3", new Set<Permission>([...BASIC, "editor.view", "maps.edit"])],
      ["4", new Set<Permission>([...BASIC, "maps.view_all"])],
      ["5", new Set<Permission>([...BASIC, "maps.view_all", "admin.users", "admin.user_types"])],
    ]),
  };
}

const EXPIRES = new Date("2030-01-01T00:00:00Z");
type GrantInput = Parameters<typeof buildViewer>[2];
function grant(over: Partial<NonNullable<GrantInput>>): GrantInput {
  return {
    id: "40",
    codeId: "4",
    codeLabel: "test",
    expiresAt: EXPIRES,
    mapLimit: "none",
    userTypeId: null,
    permissions: [],
    ...over,
  };
}

const OPEN = matrix();
const CLOSED = matrix([]);
const guest = (m = OPEN, g: GrantInput = null): Viewer => buildViewer(m, null, g);
const editor = (m = OPEN, g: GrantInput = null): Viewer =>
  buildViewer(m, { id: "7", username: "ed", userTypeId: "3" }, g);
const admin = (): Viewer => buildViewer(OPEN, { id: "1", username: "boss", userTypeId: "5" }, null);

describe("buildViewer (Milestone 99)", () => {
  it("gives everyone the public type's permissions, plus their type's and their code's", () => {
    expect([...guest().permissions].sort()).toEqual([...BASIC].sort());
    expect(editor().permissions.has("maps.edit")).toBe(true);
    expect(guest(CLOSED).permissions.size).toBe(0);
    const coded = guest(CLOSED, grant({ userTypeId: "4" }));
    expect(coded.permissions.has("maps.view_all")).toBe(true);
    expect(coded.userPermissions.size).toBe(0);
  });

  it("never lets a code carry an admin permission, whatever is stored", () => {
    const coded = guest(CLOSED, grant({ userTypeId: "5" }));
    expect(coded.permissions.has("admin.users")).toBe(false);
    const custom = guest(CLOSED, grant({ permissions: ["site.view", "admin.users"] }));
    expect([...custom.permissions]).toEqual(["site.view"]);
  });
});

describe("mapVisibilitySql", () => {
  it("a guest on an open site sees public maps only", () => {
    expect(mapVisibilitySql(guest(), "m", 3)).toEqual({
      sql: "m.visibility = 'public'",
      params: [],
    });
  });

  it("a guest without view permissions sees nothing", () => {
    expect(mapVisibilitySql(guest(CLOSED), "m", 1)).toEqual({ sql: "false", params: [] });
  });

  it("a user also sees restricted maps shared with one of their groups", () => {
    const { sql, params } = mapVisibilitySql(editor(), "x", 4);
    expect(sql).toContain("x.visibility = 'public' or exists");
    expect(sql).toContain("mvg.map_id = x.id and aug.user_id = $4::bigint");
    expect(params).toEqual(["7"]);
  });

  it("maps.view_all from the user's type sees every map", () => {
    expect(mapVisibilitySql(admin(), "m", 1)).toEqual({ sql: "true", params: [] });
  });

  it("a code giving public maps on a closed site sees public maps", () => {
    expect(mapVisibilitySql(guest(CLOSED, grant({ userTypeId: "2" })), "m", 1)).toEqual({
      sql: "m.visibility = 'public'",
      params: [],
    });
  });

  it("a code giving all maps sees every map, never a module (2026-10-12)", () => {
    expect(mapVisibilitySql(guest(CLOSED, grant({ userTypeId: "4" })), "m", 1)).toEqual({
      sql: "m.kind = 'map'",
      params: [],
    });
  });

  it("a code limited to maps gives exactly those maps (restricted too), never a module", () => {
    const { sql, params } = mapVisibilitySql(
      guest(CLOSED, grant({ userTypeId: "4", mapLimit: "maps" })),
      "m",
      1,
    );
    expect(sql).not.toContain("visibility = 'public'");
    expect(sql).toContain("m.kind = 'map' and exists");
    expect(sql).toContain("acm.code_id = $1::bigint");
    expect(params).toEqual(["4"]);
  });

  it("on an open site a map-limited code adds its maps to the public ones", () => {
    const { sql } = mapVisibilitySql(
      guest(OPEN, grant({ userTypeId: "2", mapLimit: "maps" })),
      "m",
      2,
    );
    expect(sql).toContain("m.visibility = 'public' or (m.kind = 'map' and exists");
  });

  it("a user with a code gets their groups' maps and the code's maps", () => {
    const { sql, params } = mapVisibilitySql(
      editor(OPEN, grant({ codeId: "5", userTypeId: "2", mapLimit: "maps" })),
      "m",
      3,
    );
    expect(sql).toContain("aug.user_id = $3::bigint");
    expect(sql).toContain("acm.code_id = $4::bigint");
    expect(params).toEqual(["7", "5"]);
  });
});

describe("viewerMayUseSite", () => {
  it("needs site.view, from any source", () => {
    expect(viewerMayUseSite(guest())).toBe(true);
    expect(viewerMayUseSite(guest(CLOSED))).toBe(false);
    expect(viewerMayUseSite(guest(CLOSED, grant({ userTypeId: "2" })))).toBe(true);
    expect(viewerMayUseSite(editor(CLOSED))).toBe(true);
  });
});

describe("editorRoutePermission", () => {
  it("names the write routes, and defaults to view for reads and edit for other writes", () => {
    expect(editorRoutePermission("POST", "/api/v1/editor/maps/:slug/publish")).toBe("maps.publish");
    expect(editorRoutePermission("PUT", "/api/v1/editor/maps/:slug/draft")).toBe("maps.edit");
    expect(editorRoutePermission("POST", "/api/v1/editor/maps/:slug/validate")).toBe("editor.view");
    expect(editorRoutePermission("GET", "/api/v1/editor/maps/:slug/draft")).toBe("editor.view");
    expect(editorRoutePermission("POST", "/api/v1/editor/something/new")).toBe("maps.edit");
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

function fakeSiteAccess(
  m: PermissionMatrix,
  grants: Record<string, ActiveGrant> = {},
  users: Record<string, string> = { "7": "3", "1": "5" },
): SiteAccess & { noted: string[] } {
  const noted: string[] = [];
  return {
    noted,
    matrix: async () => m,
    userAccess: async (userId) => (users[userId] ? { userTypeId: users[userId]! } : null),
    grantForToken: async (token) => (token ? (grants[token] ?? null) : null),
    noteActivity: (grantId, ip) => {
      noted.push(`${grantId}@${ip}`);
    },
    invalidate: () => undefined,
    flush: async () => undefined,
    close: async () => undefined,
  };
}

const SESSIONS = {
  "editor-token": { userId: "7", username: "ed" },
  "admin-token": { userId: "1", username: "boss" },
  "gone-token": { userId: "99", username: "deleted" },
};

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

describe("mapVisibilityHook", () => {
  const pool = fakePool({
    lancaster: { guest: true, user: true },
    "staff-map": { guest: false, user: true },
    "admin-map": { guest: false, user: false },
  });

  async function buildApp() {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.decorateRequest("authSession", null);
    app.decorateRequest("viewer", null);
    app.addHook(
      "preHandler",
      mapVisibilityHook({
        pool,
        redis: fakeRedis(SESSIONS),
        sessionTtlSeconds: 60,
        siteAccess: fakeSiteAccess(OPEN),
      }),
    );
    app.get<{ Params: { slug: string } }>("/maps/:slug", async (request) => ({
      slug: request.params.slug,
      user: request.viewer?.user ?? null,
    }));
    app.get("/list", async (request) => ({ user: request.viewer?.user ?? null }));
    return app;
  }

  it("answers 404 MAP_NOT_FOUND for a map the viewer may not see, never 403", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/maps/staff-map" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MAP_NOT_FOUND");
  });

  it("lets a group member through to a restricted map, and maps.view_all through to any", async () => {
    const app = await buildApp();
    const asEditor = await app.inject({
      method: "GET",
      url: "/maps/staff-map",
      cookies: { rlm_session: "editor-token" },
    });
    expect(asEditor.statusCode).toBe(200);
    expect(asEditor.json().user).toEqual({ id: "7", username: "ed", userTypeId: "3" });

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
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/maps/lancaster" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/maps/nowhere" })).statusCode).toBe(200);
  });

  it("treats an expired session, or one whose user is gone or inactive, as a guest", async () => {
    const app = await buildApp();
    for (const token of ["expired-token", "gone-token"]) {
      const response = await app.inject({
        method: "GET",
        url: "/list",
        cookies: { rlm_session: token },
      });
      expect(response.json().user).toBeNull();
    }
  });
});

describe("requirePermission", () => {
  async function buildApp(permission: Permission) {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.decorateRequest("authSession", null);
    app.decorateRequest("viewer", null);
    app.addHook(
      "preHandler",
      requirePermission(permission, {
        redis: fakeRedis(SESSIONS),
        sessionTtlSeconds: 60,
        siteAccess: fakeSiteAccess(CLOSED),
      }),
    );
    app.get("/x", async () => ({ ok: true }));
    return app;
  }

  it("401s a visitor with no login and no code, 403s anyone else lacking it, passes holders", async () => {
    const app = await buildApp("maps.edit");
    expect((await app.inject({ method: "GET", url: "/x" })).statusCode).toBe(401);
    const asAdmin = await app.inject({
      method: "GET",
      url: "/x",
      cookies: { rlm_session: "admin-token" },
    });
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json().error.code).toBe("FORBIDDEN");
    const asEditor = await app.inject({
      method: "GET",
      url: "/x",
      cookies: { rlm_session: "editor-token" },
    });
    expect(asEditor.statusCode).toBe(200);
  });
});

describe("siteAccessHook", () => {
  const token = "a".repeat(64);
  const basicGrant: ActiveGrant = {
    id: "40",
    codeId: "4",
    expiresAt: EXPIRES,
    codeLabel: "test",
    grantKind: "user_type",
    userTypeId: "2",
    permissions: [],
    mapLimit: "none",
  };

  async function gatedApp(siteAccess: SiteAccess) {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.decorateRequest("authSession", null);
    app.decorateRequest("viewer", null);
    app.addHook(
      "onRequest",
      siteAccessHook({ redis: fakeRedis(SESSIONS), sessionTtlSeconds: 60, siteAccess }),
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

  it("asks a visitor without site.view for a code, on every API route but login, access and health", async () => {
    const app = await gatedApp(fakeSiteAccess(CLOSED));
    const blocked = await app.inject({ method: "GET", url: "/api/v1/maps" });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe("ACCESS_CODE_REQUIRED");
    for (const url of ["/api/v1/access/status", "/api/v1/auth/me", "/health/live"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
  });

  it("lets in a code holder (counting the request) and a logged-in user", async () => {
    const siteAccess = fakeSiteAccess(CLOSED, { [token]: basicGrant });
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

  it("does nothing when the public type has site.view", async () => {
    const app = await gatedApp(fakeSiteAccess(OPEN));
    expect((await app.inject({ method: "GET", url: "/api/v1/maps" })).statusCode).toBe(200);
  });
});

describe("a closed site's public type (Milestone 99)", () => {
  it("gives a guest nothing while it lacks site.view, whatever else it keeps", () => {
    const closedButTicked = matrix(["maps.view_public", "map.playback"]);
    expect(guest(closedButTicked).permissions.size).toBe(0);
    // ... so a map-limited code gives exactly its maps.
    const { sql } = mapVisibilitySql(
      guest(closedButTicked, grant({ userTypeId: "2", mapLimit: "maps" })),
      "m",
      1,
    );
    expect(sql).not.toContain("visibility = 'public'");
  });
});
