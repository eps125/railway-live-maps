import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerBerthExplorerRoutes } from "./berthExplorer.js";
import { recordObservedBerthEvent } from "../../testSupport/tdEvents.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

async function buildApp() {
  const app = Fastify();
  await registerBerthExplorerRoutes(app, { pool });
  await app.ready();
  return app;
}

/** Unique four-character berth codes, so rows from earlier runs in the shared area never match. */
function berthCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase()}`;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function activity(
  tdArea: string,
  berth: string,
  day: string,
  source: "live" | "backfill",
  eventsIn: number,
  eventsOut: number,
): Promise<void> {
  await pool.query(
    `insert into td_berth_daily_activity (
       td_area, activity_date, berth, source, events_in, events_out, first_event_at, last_event_at
     ) values ($1, $2::date, $3, $4, $5, $6,
               $2::date::timestamp at time zone 'UTC' + interval '1 hour',
               $2::date::timestamp at time zone 'UTC' + interval '2 hours')`,
    [tdArea, day, berth, source, eventsIn, eventsOut],
  );
}

describe("admin Berth explorer routes (integration, Milestone 72)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lists berths seen in the window with their map allocations, including combined and unseen", async () => {
    const app = await buildApp();
    const a = berthCode("A");
    const b = berthCode("B");
    const c = berthCode("C");
    const d = berthCode("D");
    const e = berthCode("E");
    const u = berthCode("U");

    await activity("WX", a, daysAgo(0), "live", 2, 1);
    await activity("WX", a, daysAgo(1), "backfill", 1, 0);
    await activity("WX", a, daysAgo(20), "backfill", 5, 5); // outside 7 days, inside 30
    await activity("WX", b, daysAgo(0), "live", 1, 1);
    await activity("WY", c, daysAgo(0), "live", 1, 1); // another area
    await activity("WX", d, daysAgo(2), "live", 1, 0);
    await activity("WX", e, daysAgo(3), "live", 0, 1);
    await activity("WX", u, daysAgo(100), "backfill", 1, 1); // bound, long unseen

    // Published: A alone on element e1; B (WX) + C (WY) combined on element e2; U alone on e3.
    const slug = `explorer-${randomUUID().slice(0, 8)}`;
    const map = await pool.query<{ id: string }>(
      "insert into map (slug, name) values ($1, 'Explorer test') returning id",
      [slug],
    );
    const version = await pool.query<{ id: string }>(
      `insert into map_version (
         map_id, version_number, canonical_document, compiled_runtime_bundle,
         effective_from, published_by, schema_version, checksum
       ) values ($1, 1, $2, '{}', now() - interval '1 day', 'test', 1, 'test-checksum')
       returning id`,
      [map.rows[0]!.id, JSON.stringify({ elements: [{ id: "e1", displayName: "Up main" }] })],
    );
    for (const [element, area, berth, order] of [
      ["e1", "WX", a, null],
      ["e2", "WX", b, 1],
      ["e2", "WY", c, 2],
      ["e3", "WX", u, null],
    ] as const) {
      await pool.query(
        `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth, combined_order)
         values ($1, $2, 'td_berth', $3, $4, $5)`,
        [version.rows[0]!.id, element, area, berth, order],
      );
    }
    // Draft: D on element d1.
    const draftSlug = `explorer-draft-${randomUUID().slice(0, 8)}`;
    await pool.query("insert into map_draft (slug, canonical_document) values ($1, $2)", [
      draftSlug,
      JSON.stringify({
        elements: [{ id: "d1", displayName: "Down relief" }],
        bindings: [{ id: "x1", elementId: "d1", type: "tdBerth", tdArea: "WX", berth: d }],
      }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berth-explorer/areas/wx/berths?days=7",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ tdArea: "WX", days: 7, sinceDate: daysAgo(6) });
    const row = (berth: string) =>
      body.berths.find((r: { berth: string }) => r.berth === berth) as Record<string, unknown>;

    expect(row(a)).toMatchObject({
      eventsIn: 3,
      eventsOut: 1,
      activeDays: 2,
      lastSeenEverAt: null,
    });
    expect(row(a).allocations).toEqual([
      {
        kind: "published",
        mapSlug: slug,
        mapName: "Explorer test",
        elementId: "e1",
        displayName: "Up main",
        combinedOrder: null,
        combinedMembers: null,
      },
    ]);
    expect(row(b).allocations).toMatchObject([
      {
        kind: "published",
        combinedOrder: 1,
        combinedMembers: [
          { tdArea: "WX", berth: b },
          { tdArea: "WY", berth: c },
        ],
      },
    ]);
    expect(row(c)).toBeUndefined();
    expect(row(d).allocations).toMatchObject([
      { kind: "draft", mapSlug: draftSlug, elementId: "d1", displayName: "Down relief" },
    ]);
    expect(row(e)).toMatchObject({ eventsIn: 0, eventsOut: 1, allocations: [] });
    expect(row(u)).toMatchObject({
      eventsIn: 0,
      eventsOut: 0,
      activeDays: 0,
      lastSeenAt: null,
      lastSeenEverAt: `${daysAgo(100)}T02:00:00.000Z`,
    });

    const wider = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berth-explorer/areas/WX/berths?days=30",
    });
    expect(wider.json().berths.find((r: { berth: string }) => r.berth === a)).toMatchObject({
      eventsIn: 8,
      activeDays: 3,
    });

    // An unknown window falls back to 7 days; a bad area is rejected.
    const fallback = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berth-explorer/areas/WX/berths?days=5",
    });
    expect(fallback.json().days).toBe(7);
    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berth-explorer/areas/WXX/berths",
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("pages through a berth's steps newest first, reading only its active days", async () => {
    const app = await buildApp();
    const s = berthCode("S");
    const x = berthCode("X");
    await recordObservedBerthEvent(pool, "WX", null, s, "3A01"); // CC into S
    await recordObservedBerthEvent(pool, "WX", s, x, "3A01"); // CA out of S
    await recordObservedBerthEvent(pool, "WX", null, s, "3A02"); // CC into S
    await recordObservedBerthEvent(pool, "WX", null, x, "3A03"); // not S: excluded
    // The helper does not run the projector, so record the active days it would have.
    await activity("WX", s, daysAgo(0), "live", 2, 1);
    await activity("WX", s, daysAgo(1), "live", 0, 0);

    const base = `/api/v1/admin/berth-explorer/areas/WX/berths/${s}/steps`;
    const first = await app.inject({ method: "GET", url: `${base}?limit=2` });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.steps.map((st: { description: string }) => st.description)).toEqual([
      "3A02",
      "3A01",
    ]);
    expect(page1.steps[1]).toMatchObject({ messageType: "CA", fromBerth: s, toBerth: x });
    expect(page1.next).not.toBeNull();

    const params = new URLSearchParams({ limit: "2", before: page1.next.before });
    if (page1.next.beforeId) params.set("beforeId", page1.next.beforeId);
    const second = (
      await app.inject({ method: "GET", url: `${base}?${params.toString()}` })
    ).json();
    expect(
      second.steps.map((st: { description: string; messageType: string }) => [
        st.description,
        st.messageType,
      ]),
    ).toEqual([["3A01", "CC"]]);
    expect(second.next).toBeNull();

    // A berth with no recorded activity has no steps, without scanning anything.
    const none = await app.inject({
      method: "GET",
      url: `/api/v1/admin/berth-explorer/areas/WX/berths/${berthCode("N")}/steps`,
    });
    expect(none.json()).toMatchObject({ steps: [], next: null });
    await app.close();
  });
});
