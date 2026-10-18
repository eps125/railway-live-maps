import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewPanel, type ModuleChange } from "./ReviewPanel.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CHANGES: ModuleChange[] = [
  {
    slug: "madeley",
    name: "Madeley",
    status: "never_published",
    draftRevision: 4,
    publishedVersion: null,
  },
  {
    slug: "basford-hall",
    name: "Basford Hall",
    status: "changed",
    draftRevision: 11,
    publishedVersion: 3,
  },
  {
    slug: "stafford",
    name: "Stafford",
    status: "unchanged",
    draftRevision: 2,
    publishedVersion: 1,
  },
];

/** Stubs fetch: `module-changes` answers with `changes`, `publish` with `publishBody`. Returns the
 * publish request bodies sent. */
function stubFetch(changes: ModuleChange[], publishBody: unknown): unknown[] {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/module-changes")) return json({ modules: changes });
      if (url.endsWith("/publish")) {
        sent.push(JSON.parse(String(init?.body)));
        return json(publishBody);
      }
      return json({}, 404);
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Milestone 96: publishing an assembled map offers to publish its changed modules with it. */
describe("ReviewPanel module publish choice", () => {
  it("lists changed and never-published modules and publishes them with the map by default", async () => {
    const sent = stubFetch(CHANGES, {
      kind: "map",
      versionNumber: 3,
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      modules: [
        { slug: "basford-hall", versionNumber: 4 },
        { slug: "madeley", versionNumber: 1 },
      ],
      cascade: [{ slug: "crewe-area", ok: true, versionNumber: 26 }],
    });
    const onPublished = vi.fn();
    render(<ReviewPanel slug="crewe-colwich" syncedRevision={2} onPublished={onPublished} />);

    expect(await screen.findByText("Madeley")).toBeTruthy();
    expect(screen.getByText(/never published/)).toBeTruthy();
    expect(screen.getByText(/changed since version 3/)).toBeTruthy();
    expect(screen.queryByText("Stafford")).toBeNull();
    const withModules = screen.getByLabelText(/these modules with the map/) as HTMLInputElement;
    expect(withModules.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText(/Published with it: basford-hall \(module version 4\)/);
    expect(sent[0]).toMatchObject({
      expectedRevision: 2,
      publishModules: [
        { slug: "madeley", expectedRevision: 4 },
        { slug: "basford-hall", expectedRevision: 11 },
      ],
    });
    expect(screen.getByText(/crewe-area/)).toBeTruthy();
    // Stays on Review so the author sees what was published with the map.
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("publishes the map only when chosen, warning about never-published modules", async () => {
    const sent = stubFetch(CHANGES, {
      kind: "map",
      versionNumber: 3,
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      modules: [],
      cascade: [],
    });
    const onPublished = vi.fn();
    render(<ReviewPanel slug="crewe-colwich" syncedRevision={2} onPublished={onPublished} />);

    fireEvent.click(await screen.findByLabelText(/Publish the map only/));
    expect(screen.getByRole("alert").textContent).toMatch(/Madeley has never been published/);

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(sent[0]).not.toHaveProperty("publishModules");
  });

  it("shows no choice for a map whose modules are all published", async () => {
    const sent = stubFetch([CHANGES[2]!], {
      kind: "map",
      versionNumber: 5,
      effectiveFrom: "1970-01-01T00:00:00.000Z",
    });
    render(<ReviewPanel slug="crewe-colwich" syncedRevision={7} onPublished={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Modules with unpublished changes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText(/Published version 5/);
    expect(sent[0]).not.toHaveProperty("publishModules");
  });
});
