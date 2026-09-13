import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPool, createUser } from "@railway/database";
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

/** Logs a fresh user in through the real `/api/v1/auth/login` route and returns the `Set-Cookie`
 * value to replay on subsequent `inject()` calls — proves the whole login->session->preHandler
 * chain end to end rather than fabricating a session directly in Redis. */
async function loginAndGetCookie(
  app: Awaited<ReturnType<typeof buildServer>>["app"],
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookie) throw new Error("login did not set a session cookie");
  return cookie.split(";")[0]!;
}

/**
 * Milestone 29: replaces the old `EDITOR_ENABLED` boolean-gating tests — editor/admin routes are
 * now always registered but always require a real session at the right role.
 */
describe("buildServer: role-based route gating (integration)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("editor routes 401 with no session", async () => {
    const built = await buildServer(testConfig());
    close = built.close;

    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${randomUUID()}/draft`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("editor routes work for a logged-in editor, and admin routes 403 for that same editor", async () => {
    const built = await buildServer(testConfig());
    close = built.close;

    const pool = createPool({ connectionString: testConfig().DATABASE_URL });
    const username = `editor-${randomUUID()}`;
    await createUser(pool, { username, password: "correct-horse-battery", role: "editor" });
    await pool.end();

    const cookie = await loginAndGetCookie(built.app, username, "correct-horse-battery");

    const draftResponse = await built.app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${randomUUID()}/draft`,
      headers: { cookie },
    });
    expect(draftResponse.statusCode).toBe(200);
    expect(draftResponse.json().revision).toBe(1);

    const adminResponse = await built.app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie },
    });
    expect(adminResponse.statusCode).toBe(403);

    // Milestone 30: creating a map is admin-only even though it lives under `/api/v1/editor/*` —
    // an editor session gets the same 403 an admin-only route gives.
    const createMapResponse = await built.app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      headers: { cookie },
      payload: { slug: `should-not-be-created-${randomUUID()}`, name: "x" },
    });
    expect(createMapResponse.statusCode).toBe(403);

    // Owner request (2026-09-13): rename/delete are admin-only too, same as create.
    const renameResponse = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${randomUUID()}`,
      headers: { cookie },
      payload: { name: "x" },
    });
    expect(renameResponse.statusCode).toBe(403);

    const deleteResponse = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/editor/maps/${randomUUID()}`,
      headers: { cookie },
    });
    expect(deleteResponse.statusCode).toBe(403);
  });

  it("admin routes work for a logged-in admin", async () => {
    const built = await buildServer(testConfig());
    close = built.close;

    const pool = createPool({ connectionString: testConfig().DATABASE_URL });
    const username = `admin-${randomUUID()}`;
    await createUser(pool, { username, password: "correct-horse-battery", role: "admin" });
    await pool.end();

    const cookie = await loginAndGetCookie(built.app, username, "correct-horse-battery");

    const adminResponse = await built.app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie },
    });
    expect(adminResponse.statusCode).toBe(200);
    expect(Array.isArray(adminResponse.json().users)).toBe(true);

    // Milestone 30: an admin session can reach the create-map route.
    const createMapResponse = await built.app.inject({
      method: "POST",
      url: "/api/v1/editor/maps",
      headers: { cookie },
      payload: { slug: `admin-created-${randomUUID()}`, name: "Admin Created Map" },
    });
    expect(createMapResponse.statusCode).toBe(201);
    const createdSlug = createMapResponse.json().slug as string;

    // Owner request (2026-09-13): an admin session can rename, then delete, that same map.
    const renameResponse = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/editor/maps/${createdSlug}`,
      headers: { cookie },
      payload: { name: "Renamed by admin" },
    });
    expect(renameResponse.statusCode).toBe(200);

    const deleteResponse = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/editor/maps/${createdSlug}`,
      headers: { cookie },
    });
    expect(deleteResponse.statusCode).toBe(204);
  });

  it("public routes need no session at all", async () => {
    const built = await buildServer(testConfig());
    close = built.close;

    const response = await built.app.inject({ method: "GET", url: "/api/v1/maps" });
    expect(response.statusCode).toBe(200);
  });
});
