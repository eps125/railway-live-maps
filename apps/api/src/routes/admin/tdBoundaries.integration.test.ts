import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerTdBoundaryRoutes } from "./tdBoundaries.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdIds: string[] = [];

function uniqueArea(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

async function buildApp() {
  const app = Fastify();
  await registerTdBoundaryRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("admin TD boundary routes (integration)", () => {
  afterAll(async () => {
    if (createdIds.length > 0) {
      await pool.query("delete from td_area_boundary where id = any($1::bigint[])", [createdIds]);
    }
    await pool.end();
  });

  it("creates a boundary via POST, then lists it via GET", async () => {
    const app = await buildApp();
    const areaA = uniqueArea("A");
    const areaB = uniqueArea("B");

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/td-boundaries",
      payload: { areaA, berthA: "0001", areaB, berthB: "0099", notes: "test crossing" },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created).toMatchObject({
      areaA,
      berthA: "0001",
      areaB,
      berthB: "0099",
      notes: "test crossing",
    });
    createdIds.push(created.id);

    const listResponse = await app.inject({ method: "GET", url: "/api/v1/admin/td-boundaries" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().boundaries.some((b: { id: string }) => b.id === created.id)).toBe(
      true,
    );

    await app.close();
  });

  it("rejects a duplicate (areaA, berthA, areaB, berthB) pair with 409", async () => {
    const app = await buildApp();
    const areaA = uniqueArea("C");
    const areaB = uniqueArea("D");
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/admin/td-boundaries",
      payload: { areaA, berthA: "0002", areaB, berthB: "0098" },
    });
    createdIds.push(first.json().id);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/admin/td-boundaries",
      payload: { areaA, berthA: "0002", areaB, berthB: "0098" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("DUPLICATE_BOUNDARY");

    await app.close();
  });

  it("rejects a missing field with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/td-boundaries",
      payload: { areaA: "PX", berthA: "0001", areaB: "", berthB: "0099" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE removes a boundary, and a second delete 404s", async () => {
    const app = await buildApp();
    const areaA = uniqueArea("E");
    const areaB = uniqueArea("F");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/td-boundaries",
        payload: { areaA, berthA: "0003", areaB, berthB: "0097" },
      })
    ).json();

    const first = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/td-boundaries/${created.id}`,
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/td-boundaries/${created.id}`,
    });
    expect(second.statusCode).toBe(404);

    await app.close();
  });
});
