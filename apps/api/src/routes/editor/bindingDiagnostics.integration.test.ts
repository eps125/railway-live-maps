import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerEditorBindingDiagnosticsRoutes } from "./bindingDiagnostics.js";
import { recordObservedBerthEvent } from "../../testSupport/tdEvents.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function buildApp() {
  const app = Fastify();
  await registerEditorBindingDiagnosticsRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("GET /api/v1/editor/bindings/td/:area/:berth/diagnostics (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("reports everObserved=false, zero events, and no current state for a never-seen binding", async () => {
    const area = uniqueArea();
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/editor/bindings/td/${area}/9999/diagnostics`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        tdArea: area,
        berth: "9999",
        everObserved: false,
        eventCount: 0,
        currentDescription: null,
      });
    } finally {
      await app.close();
    }
  });

  it("reports everObserved=true with observed timestamps and current state for a seen binding", async () => {
    const area = uniqueArea();
    await recordObservedBerthEvent(pool, area, null, "0001", "1A23");

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/editor/bindings/td/${area}/0001/diagnostics`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.everObserved).toBe(true);
      expect(body.eventCount).toBe(1);
      expect(body.firstObservedAt).not.toBeNull();
      expect(body.currentDescription).toBe("1A23");
    } finally {
      await app.close();
    }
  });
});
