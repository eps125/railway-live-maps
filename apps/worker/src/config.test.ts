import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgres://u:p@localhost/db",
  REDIS_URL: "redis://localhost:6379",
  RAW_ARCHIVE_ENDPOINT: "http://localhost:9000",
  RAW_ARCHIVE_BUCKET: "b",
  RAW_ARCHIVE_ACCESS_KEY: "k",
  RAW_ARCHIVE_SECRET_KEY: "s",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig — garner bridge", () => {
  it("defaults the bridge off and does not require GARNER_DB_*", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.GARNER_BRIDGE_ENABLED).toBe(false);
    expect(config.GARNER_DB_PORT).toBe(3306);
    expect(config.GARNER_BRIDGE_BACKFILL_DAYS).toBe(14);
  });

  it("requires GARNER_DB_HOST and GARNER_DB_USER when the bridge is enabled", () => {
    expect(() => loadConfig({ ...baseEnv, GARNER_BRIDGE_ENABLED: "true" })).toThrow(
      /GARNER_DB_HOST and GARNER_DB_USER/,
    );
    expect(() =>
      loadConfig({ ...baseEnv, GARNER_BRIDGE_ENABLED: "true", GARNER_DB_HOST: "10.1.1.66" }),
    ).toThrow(/GARNER_DB_HOST and GARNER_DB_USER/);
  });

  it("accepts a fully-configured enabled bridge", () => {
    const config = loadConfig({
      ...baseEnv,
      GARNER_BRIDGE_ENABLED: "true",
      GARNER_DB_HOST: "10.1.1.66",
      GARNER_DB_USER: "rlm_bridge",
      GARNER_DB_PASSWORD: "secret",
      GARNER_DB_PORT: "3307",
    });
    expect(config.GARNER_BRIDGE_ENABLED).toBe(true);
    expect(config.GARNER_DB_HOST).toBe("10.1.1.66");
    expect(config.GARNER_DB_PORT).toBe(3307);
  });
});
