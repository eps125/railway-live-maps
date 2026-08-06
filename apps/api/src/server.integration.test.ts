import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import type { Config } from "./config.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

function testConfig(editorEnabled: boolean): Config {
  return {
    APP_ENV: "test",
    PORT: 0,
    DATABASE_URL: requireEnv("DATABASE_URL"),
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    DISPLAY_TIMEZONE: "Europe/London",
    EDITOR_ENABLED: editorEnabled,
    LIVE_WS_REDIS_PUBSUB_ENABLED: false,
    LIVE_WS_POLL_INTERVAL_MS: 1000,
    LIVE_WS_HEARTBEAT_INTERVAL_MS: 15000,
  };
}

describe("buildServer: EDITOR_ENABLED gating (integration)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("editor routes do not exist (404) when EDITOR_ENABLED=false", async () => {
    const built = await buildServer(testConfig(false));
    close = built.close;

    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${randomUUID()}/draft`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("editor routes exist and function when EDITOR_ENABLED=true", async () => {
    const built = await buildServer(testConfig(true));
    close = built.close;

    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/editor/maps/${randomUUID()}/draft`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revision).toBe(1);
  });

  it("public routes are unaffected by EDITOR_ENABLED either way", async () => {
    const built = await buildServer(testConfig(false));
    close = built.close;

    const response = await built.app.inject({ method: "GET", url: "/api/v1/maps" });
    expect(response.statusCode).toBe(200);
  });
});
