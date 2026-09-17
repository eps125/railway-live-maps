import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledMapBundle } from "@railway/map-schema";
import {
  MapRenderer,
  elementCenterPoint,
  viewBoxAfterPinch,
  MIN_ZOOM_WIDTH,
} from "./MapRenderer.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // MapRenderer persists the pan/zoom view per map to localStorage — clear it so tests don't
  // start from a view a previous test saved.
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

function bundle(overrides: Partial<CompiledMapBundle> = {}): CompiledMapBundle {
  return {
    schemaVersion: 1,
    mapId: "lancaster",
    mapName: "Lancaster",
    canvas: { width: 200, height: 200, gridSize: 10 },
    timezone: "Europe/London",
    layers: [
      { id: "layer-visible", name: "Visible", order: 0, visible: true, locked: false },
      { id: "layer-hidden", name: "Hidden", order: 1, visible: false, locked: false },
    ],
    elementsById: {},
    berthBindingIndex: {},
    berthBindingOrder: {},
    sBitBindingIndex: {},
    placeBindingIndex: [],
    boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    topologyAdjacency: {},
    continuationLinks: [],
    ...overrides,
  };
}

describe("MapRenderer", () => {
  it("does not render elements on a layer marked not visible, matching the editor canvas", () => {
    const doc = bundle({
      elementsById: {
        "label-shown": {
          id: "label-shown",
          layerId: "layer-visible",
          zIndex: 0,
          type: "label",
          x: 10,
          y: 10,
          text: "Shown Label",
          align: "left",
          fontSize: 12,
        },
        "label-hidden": {
          id: "label-hidden",
          layerId: "layer-hidden",
          zIndex: 0,
          type: "label",
          x: 20,
          y: 20,
          text: "Hidden Label",
          align: "left",
          fontSize: 12,
        },
      },
    });

    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);

    expect(screen.getByText("Shown Label")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Label")).not.toBeInTheDocument();
  });

  it("paints elements in sortElementsForPaint order, not elementsById's own key order", () => {
    // Deliberately inserted with the higher zIndex element first in elementsById, so a bug that
    // trusted Object.values()'s key-insertion order instead of explicitly sorting would paint
    // this in the wrong order.
    const doc = bundle({
      elementsById: {
        "label-front": {
          id: "label-front",
          layerId: "layer-visible",
          zIndex: 10,
          type: "label",
          x: 10,
          y: 10,
          text: "Front",
          align: "left",
          fontSize: 12,
        },
        "label-back": {
          id: "label-back",
          layerId: "layer-visible",
          zIndex: 0,
          type: "label",
          x: 20,
          y: 20,
          text: "Back",
          align: "left",
          fontSize: 12,
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const texts = Array.from(container.querySelectorAll("text")).map((el) => el.textContent);
    expect(texts).toEqual(["Back", "Front"]);
  });

  it("opens the run popup when clicking a populated, bound berth (docs/PROJECT_SPEC.md §5)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0512",
            description: "2A16",
            headcode: "2A16",
            occupancyEnteredAt: null,
            matchStatus: "unmatched",
            matchBasis: null,
            positionScoped: false,
            note: "No candidate schedule found for this headcode today, mirrored from openrail-eps (garner).",
            effective: null,
            candidateSchedules: [],
            unitAllocation: [],
          }),
        ),
      ),
    );

    const doc = bundle({
      elementsById: {
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Berth 1",
        },
      },
      berthBindingIndex: { "PX|0512": "berth-1" },
    });

    render(
      <MapRenderer
        bundle={doc}
        berths={{ "berth-1": { description: "2A16", enteredAt: null } }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("2A16"));

    expect(
      await screen.findByText("No garner schedule matches headcode 2A16 today."),
    ).toBeInTheDocument();
  });

  it("opens the run popup with every combined-berth member's detail (Milestone 50)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/A001/")) {
          return Promise.resolve(
            jsonResponse({
              tdArea: "PX",
              berth: "A001",
              description: "1A11",
              headcode: "1A11",
              occupancyEnteredAt: null,
              matchStatus: "unmatched",
              matchBasis: null,
              positionScoped: false,
              note: "No candidate schedule found for this headcode today, mirrored from openrail-eps (garner).",
              effective: null,
              candidateSchedules: [],
              unitAllocation: [],
            }),
          );
        }
        if (url.includes("/B001/")) {
          return Promise.resolve(
            jsonResponse({
              tdArea: "PX",
              berth: "B001",
              description: "1B22",
              headcode: "1B22",
              occupancyEnteredAt: null,
              matchStatus: "unmatched",
              matchBasis: null,
              positionScoped: false,
              note: "No candidate schedule found for this headcode today, mirrored from openrail-eps (garner).",
              effective: null,
              candidateSchedules: [],
              unitAllocation: [],
            }),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const doc = bundle({
      elementsById: {
        "berth-combined": {
          id: "berth-combined",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Combined",
        },
      },
      berthBindingIndex: { "PX|A001": "berth-combined", "PX|B001": "berth-combined" },
      berthBindingOrder: { "PX|A001": 1, "PX|B001": 2 },
    });

    render(
      <MapRenderer
        bundle={doc}
        berths={{ "berth-combined": { description: "1A11 1B22", enteredAt: null } }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("1A11 1B22"));

    expect(await screen.findByText("PX A001")).toBeInTheDocument();
    expect(await screen.findByText("PX B001")).toBeInTheDocument();
  });

  it("closes the popup via its close button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0512",
            description: "2A16",
            headcode: "2A16",
            occupancyEnteredAt: null,
            matchStatus: "unmatched",
            matchBasis: null,
            positionScoped: false,
            note: "No candidate schedule found for this headcode today, mirrored from openrail-eps (garner).",
            effective: null,
            candidateSchedules: [],
            unitAllocation: [],
          }),
        ),
      ),
    );

    const doc = bundle({
      elementsById: {
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Berth 1",
        },
      },
      berthBindingIndex: { "PX|0512": "berth-1" },
    });

    const { container } = render(
      <MapRenderer
        bundle={doc}
        berths={{ "berth-1": { description: "2A16", enteredAt: null } }}
        signals={{}}
      />,
    );

    fireEvent.click(screen.getByText("2A16"));
    await screen.findByText("No garner schedule matches headcode 2A16 today.");
    expect(container.querySelector(".map-inspector--run")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container.querySelector(".map-inspector--run")).not.toBeInTheDocument();
  });

  it("centerElementId centres the initial view on that element's (x, y), overriding the default view (Milestone 31)", () => {
    const doc = bundle({
      boundingBox: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      elementsById: {
        "station-1": {
          id: "station-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "station",
          x: 900,
          y: 900,
          name: "Somewhere Else",
          fontSize: 16,
        },
      },
    });
    const { container } = render(
      <MapRenderer bundle={doc} berths={{}} signals={{}} centerElementId="station-1" />,
    );
    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    // Centred means the element's point sits in the middle of the viewBox, not at the
    // bounding-box centre (500, 500) the default view would have used instead.
    expect(x! + width! / 2).toBeCloseTo(900);
    expect(y! + height! / 2).toBeCloseTo(900);
  });

  it("ignores an unresolvable centerElementId (unknown id, or a points-based track/platform) and falls back to the default view", () => {
    const doc = bundle({ boundingBox: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } });
    const { container } = render(
      <MapRenderer bundle={doc} berths={{}} signals={{}} centerElementId="does-not-exist" />,
    );
    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(x! + width! / 2).toBeCloseTo(500);
    expect(y! + height! / 2).toBeCloseTo(500);
  });

  it("centres the default view on bundle.homePoint when set, instead of the bounding-box centre (2026-09-16)", () => {
    const doc = bundle({
      boundingBox: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      homePoint: { x: 250, y: 300 },
    });
    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(x! + width! / 2).toBeCloseTo(250);
    expect(y! + height! / 2).toBeCloseTo(300);
  });

  it("an explicit centerElementId still takes priority over bundle.homePoint", () => {
    const doc = bundle({
      boundingBox: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      homePoint: { x: 250, y: 300 },
      elementsById: {
        "station-1": {
          id: "station-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "station",
          x: 900,
          y: 900,
          name: "Somewhere Else",
          fontSize: 16,
        },
      },
    });
    const { container } = render(
      <MapRenderer bundle={doc} berths={{}} signals={{}} centerElementId="station-1" />,
    );
    const svg = container.querySelector("svg")!;
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(x! + width! / 2).toBeCloseTo(900);
    expect(y! + height! / 2).toBeCloseTo(900);
  });

  it("a single-finger touch still pans (proves pointer-based interaction is wired up)", () => {
    const doc = bundle();
    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const svg = container.querySelector("svg")!;
    const initialViewBox = svg.getAttribute("viewBox")!;
    const initialWidth = Number(initialViewBox.split(" ")[2]);

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 60, clientY: 100 });

    const newViewBox = svg.getAttribute("viewBox")!;
    const newWidth = Number(newViewBox.split(" ")[2]);
    // Panning moves x/y, never changes width/height.
    expect(newWidth).toBe(initialWidth);
    expect(newViewBox).not.toBe(initialViewBox);
  });

  it("centres a berth vertically on its bound track (ADR 0004 D1)", () => {
    const doc = bundle({
      elementsById: {
        trk: {
          id: "trk",
          layerId: "layer-visible",
          zIndex: 0,
          type: "trackPath",
          points: [
            { x: 0, y: 100 },
            { x: 200, y: 100 },
          ],
        },
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 40,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Berth 1",
          trackElementId: "trk",
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const rect = container.querySelector("rect")!;
    // track y 100, berth height 20 -> top at 90 so the box straddles the rail
    expect(rect.getAttribute("y")).toBe("90");
  });

  it("renders a legacy 2-point platform as an orange bar and ignores its .number (ADR 0005 rev.)", () => {
    const doc = bundle({
      elementsById: {
        "plat-1": {
          id: "plat-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "platform",
          points: [
            { x: 0, y: 50 },
            { x: 120, y: 50 },
          ],
          number: "2",
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const bar = container.querySelector("rect")!;
    expect(bar.getAttribute("fill")).toBe("var(--map-platform-fill, #ffa500)");
    // number is no longer auto-rendered — only standalone platformNumber elements draw one
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("renders a 3+ point platform as a filled polygon (ADR 0005 rev.)", () => {
    const doc = bundle({
      elementsById: {
        "plat-2": {
          id: "plat-2",
          layerId: "layer-visible",
          zIndex: 0,
          type: "platform",
          points: [
            { x: 0, y: 40 },
            { x: 120, y: 40 },
            { x: 120, y: 60 },
            { x: 0, y: 52 },
          ],
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const poly = container.querySelector("polygon")!;
    expect(poly).not.toBeNull();
    expect(poly.getAttribute("fill")).toBe("var(--map-platform-fill, #ffa500)");
    expect(poly.getAttribute("points")).toBe("0,40 120,40 120,60 0,52");
  });

  it("renders a station name with its CRS (ADR 0004 D6)", () => {
    const doc = bundle({
      elementsById: {
        "stn-1": {
          id: "stn-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "station",
          x: 100,
          y: 20,
          name: "Lancaster",
          crs: "LAN",
          fontSize: 16,
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    expect(container.querySelector("text")?.textContent).toBe("Lancaster [LAN]");
  });

  it("hides vacant berths when showEmptyBerths is false but keeps occupied ones (ADR 0004 D5)", () => {
    const berthEl = (id: string, x: number) => ({
      id,
      layerId: "layer-visible",
      zIndex: 0,
      type: "berth" as const,
      x,
      y: 10,
      width: 40,
      height: 20,
      textAlign: "center" as const,
      fontSize: 12,
      displayName: id,
    });
    const doc = bundle({
      elementsById: {
        "berth-empty": berthEl("berth-empty", 0),
        "berth-full": berthEl("berth-full", 80),
      },
    });

    const { container } = render(
      <MapRenderer
        bundle={doc}
        berths={{ "berth-full": { description: "1A01", enteredAt: null } }}
        signals={{}}
        showEmptyBerths={false}
      />,
    );

    expect(container.querySelectorAll("rect")).toHaveLength(1);
    expect(screen.getByText("1A01")).toBeInTheDocument();
  });

  it("renders a standalone platformNumber element (ADR 0005 E3)", () => {
    const doc = bundle({
      elementsById: {
        "pn-1": {
          id: "pn-1",
          layerId: "layer-visible",
          zIndex: 1,
          type: "platformNumber",
          x: 50,
          y: 30,
          text: "4",
          fontSize: 10,
        },
      },
    });
    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("draws a stem for an offset-mode signal, none for inline (ADR 0005 E4)", () => {
    const mk = (id: string, renderMode?: "inline" | "offset") => ({
      id,
      layerId: "layer-visible",
      zIndex: 0,
      type: "signal" as const,
      x: 20,
      y: 20,
      orientation: 0,
      symbolStyle: "signal-blank" as const,
      ...(renderMode ? { renderMode } : {}),
    });

    const inline = render(
      <MapRenderer bundle={bundle({ elementsById: { s: mk("s") } })} berths={{}} signals={{}} />,
    );
    expect(inline.container.querySelector("line")).toBeNull();

    const offset = render(
      <MapRenderer
        bundle={bundle({ elementsById: { s: mk("s", "offset") } })}
        berths={{}}
        signals={{}}
      />,
    );
    expect(offset.container.querySelector("line")).not.toBeNull();
  });

  it("renders a berth blank when its inhibiting berth shows the identical description (TD-area fringe pair)", () => {
    const berthEl = (id: string, x: number, inhibitedBy?: string) => ({
      id,
      layerId: "layer-visible",
      zIndex: 0,
      type: "berth" as const,
      x,
      y: 10,
      width: 40,
      height: 20,
      textAlign: "center" as const,
      fontSize: 12,
      displayName: id,
      ...(inhibitedBy ? { inhibitedBy } : {}),
    });
    const doc = bundle({
      elementsById: {
        "berth-px": berthEl("berth-px", 0, "berth-cl"),
        "berth-cl": berthEl("berth-cl", 80),
      },
    });

    const { container, rerender } = render(
      <MapRenderer
        bundle={doc}
        berths={{
          "berth-px": { description: "1S56", enteredAt: null },
          "berth-cl": { description: "1S56", enteredAt: null },
        }}
        signals={{}}
      />,
    );

    // Both berths carry the same real headcode, but berth-px is inhibited by berth-cl, so it
    // renders as if vacant — only one "1S56" text node, and berth-px's rect is the vacant fill.
    expect(screen.getAllByText("1S56")).toHaveLength(1);
    const rects = container.querySelectorAll("rect");
    expect(rects[0]!.getAttribute("fill")).toBe("#161d27"); // vacant
    expect(rects[1]!.getAttribute("fill")).toBe("#3d7fc4"); // occupied

    // Once the descriptions genuinely differ (the train has moved on from one side), both show
    // their real, distinct state — inhibition only applies to a real match.
    rerender(
      <MapRenderer
        bundle={doc}
        berths={{
          "berth-px": { description: "1S56", enteredAt: null },
          "berth-cl": { description: "2A16", enteredAt: null },
        }}
        signals={{}}
      />,
    );
    expect(screen.getByText("1S56")).toBeInTheDocument();
    expect(screen.getByText("2A16")).toBeInTheDocument();
  });

  it("does nothing when clicking an unbound or empty berth — only occupied berths are clickable", () => {
    const doc = bundle({
      elementsById: {
        "berth-1": {
          id: "berth-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "berth",
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          textAlign: "center",
          fontSize: 12,
          displayName: "Berth 1",
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    const rect = container.querySelector("rect")!;
    fireEvent.click(rect);

    expect(container.querySelector(".map-inspector")).not.toBeInTheDocument();
  });

  it("clicking a boundary with adjacentMapSlug navigates using adjacentBoundaryName, not its own name (Milestone 32 — sides name a boundary differently)", () => {
    window.history.pushState(null, "", "/map/preston");
    const doc = bundle({
      elementsById: {
        "boundary-1": {
          id: "boundary-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "boundary",
          x: 5,
          y: 5,
          name: "Preston PSB",
          adjacentMapSlug: "carlisle",
          adjacentBoundaryName: "Carlisle PSB",
        },
      },
    });

    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    fireEvent.click(screen.getByText("Preston PSB"));

    expect(window.location.pathname).toBe("/map/carlisle");
    expect(window.location.search).toBe("?boundary=Carlisle%20PSB");
  });

  it("falls back to the boundary's own name when adjacentBoundaryName is unset", () => {
    window.history.pushState(null, "", "/map/preston");
    const doc = bundle({
      elementsById: {
        "boundary-1": {
          id: "boundary-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "boundary",
          x: 5,
          y: 5,
          name: "North",
          adjacentMapSlug: "carnforth",
        },
      },
    });

    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    fireEvent.click(screen.getByText("North"));

    expect(window.location.pathname).toBe("/map/carnforth");
    expect(window.location.search).toBe("?boundary=North");
  });

  it("a boundary with no adjacentMapSlug is inert — no click handler, default cursor", () => {
    const doc = bundle({
      elementsById: {
        "boundary-1": {
          id: "boundary-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "boundary",
          x: 5,
          y: 5,
          name: "North",
        },
      },
    });

    window.history.pushState(null, "", "/map/preston");
    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    fireEvent.click(screen.getByText("North"));

    expect(window.location.pathname).toBe("/map/preston");
  });

  it("a label carrying adjacentMapSlug is clickable and navigates like a boundary, but keeps the normal label style (Milestone 32, folded into label 2026-09-13)", () => {
    window.history.pushState(null, "", "/map/preston");
    const doc = bundle({
      elementsById: {
        "label-1": {
          id: "label-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "label",
          x: 5,
          y: 5,
          text: "Preston PSB",
          align: "left",
          fontSize: 12,
          adjacentMapSlug: "carlisle",
          adjacentBoundaryName: "Carlisle PSB",
        },
      },
    });

    const { container } = render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    // Normal label style: a plain <text>, no <circle> marker the legacy boundary type drew.
    expect(container.querySelector("circle")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Preston PSB"));

    expect(window.location.pathname).toBe("/map/carlisle");
    expect(window.location.search).toBe("?boundary=Carlisle%20PSB");
  });

  it("a label with no adjacentMapSlug is a plain, non-clickable label as always", () => {
    window.history.pushState(null, "", "/map/preston");
    const doc = bundle({
      elementsById: {
        "label-1": {
          id: "label-1",
          layerId: "layer-visible",
          zIndex: 0,
          type: "label",
          x: 5,
          y: 5,
          text: "Just a label",
          align: "left",
          fontSize: 12,
        },
      },
    });

    render(<MapRenderer bundle={doc} berths={{}} signals={{}} />);
    fireEvent.click(screen.getByText("Just a label"));

    expect(window.location.pathname).toBe("/map/preston");
  });
});

describe("viewBoxAfterPinch", () => {
  const origin = { x: 0, y: 0, width: 1000, height: 1000 };

  it("fingers moving apart (distance grows) zooms in — smaller viewBox, same center", () => {
    const result = viewBoxAfterPinch({ startDistance: 20, origin }, 60);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(333.333); // 1000 * (20/60)
    expect(result!.height).toBeCloseTo(333.333);
    // Center stays fixed: origin's center was (500,500); new box must still center there.
    expect(result!.x + result!.width / 2).toBeCloseTo(500);
    expect(result!.y + result!.height / 2).toBeCloseTo(500);
  });

  it("fingers moving together (distance shrinks) zooms out — larger viewBox", () => {
    const result = viewBoxAfterPinch({ startDistance: 20, origin }, 10);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(2000); // 1000 * (20/10)
  });

  it("never zooms in past MIN_ZOOM_WIDTH", () => {
    const result = viewBoxAfterPinch({ startDistance: 20, origin }, 10_000);
    expect(result!.width).toBe(MIN_ZOOM_WIDTH);
    expect(result!.height).toBe(MIN_ZOOM_WIDTH);
  });

  it("returns null for a zero distance rather than dividing by zero", () => {
    expect(viewBoxAfterPinch({ startDistance: 20, origin }, 0)).toBeNull();
  });
});

describe("elementCenterPoint", () => {
  it("returns (x, y) for a point-shaped element", () => {
    expect(
      elementCenterPoint({
        id: "s",
        layerId: "l",
        zIndex: 0,
        type: "station",
        x: 5,
        y: 7,
        name: "X",
        fontSize: 16,
      }),
    ).toEqual({ x: 5, y: 7 });
  });

  it("returns null for a points-based element (trackPath/platform) and for undefined", () => {
    expect(
      elementCenterPoint({
        id: "t",
        layerId: "l",
        zIndex: 0,
        type: "trackPath",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    ).toBeNull();
    expect(elementCenterPoint(undefined)).toBeNull();
  });
});
