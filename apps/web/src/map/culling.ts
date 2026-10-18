import {
  bufferStopBounds,
  levelCrossingGeometry,
  neutralSectionGeometry,
  placedLabelAnchor,
  platformNumberGeometry,
  pointsBounds,
  type MapElement,
  type PlacedLabel,
} from "@railway/map-schema";

/**
 * Milestone 94: viewport culling for large maps. Every element costs the browser paint, layer
 * and commit work on *every* live update and zoom step (measured: ~200 ms per berth step on a
 * 20k-element map), however little changed. So a map at least `CULL_MIN_ELEMENTS` big draws
 * only the elements whose drawing could be within about a window of what is on screen.
 *
 * Purely a drawing optimisation: live state, the popup, search centring and boundary links all
 * work from the bundle, never from what happens to be drawn.
 */
export const CULL_MIN_ELEMENTS = 1000;

/** Map-unit rectangle, inclusive. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Slack added round every estimated drawing, for strokes, posts and text overhang. */
const PAD = 12;

function fromRect(r: { x: number; y: number; width: number; height: number }, pad = PAD): Box {
  return {
    minX: r.x - pad,
    minY: r.y - pad,
    maxX: r.x + r.width + pad,
    maxY: r.y + r.height + pad,
  };
}

function around(x: number, y: number, r: number): Box {
  return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
}

function union(a: Box, b: Box | null): Box {
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** A generous estimate of where a piece of text is drawn: wide glyphs (0.7 em) and the full
 * line height on every line, so the estimate is never smaller than the real text. */
function textBox(
  x: number,
  y: number,
  text: string,
  fontSize: number,
  anchor: "start" | "middle" | "end",
): Box {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => l.length)) * fontSize * 0.7;
  const left = anchor === "start" ? x : anchor === "middle" ? x - width / 2 : x - width;
  return {
    minX: left - PAD,
    minY: y - fontSize * 1.2 - PAD,
    maxX: left + width + PAD,
    maxY: y + lines.length * fontSize * 1.3 + PAD,
  };
}

function placedText(at: PlacedLabel, text: string | undefined, fontSize: number): Box | null {
  return text ? textBox(at.x, at.y, text, fontSize, at.anchor) : null;
}

/**
 * Where an element is drawn, generously. `null` means "not worked out" — such an element is
 * always drawn, so an element type added later can never silently vanish from the map.
 */
export function elementDrawBounds(
  element: MapElement,
  berthRect: { x: number; y: number; width: number; height: number } | undefined,
): Box | null {
  switch (element.type) {
    case "berth":
      return fromRect(berthRect ?? element);
    case "signal": {
      // Post, head and TRTS dot sit within ~40 units; the number defaults to beside the berth
      // it protects, or the author's offset from (x, y).
      const box = around(element.x, element.y, 90);
      const offset = (element as { labelOffset?: { x: number; y: number } }).labelOffset;
      return offset ? union(box, around(element.x + offset.x, element.y + offset.y, 60)) : box;
    }
    case "label":
      return textBox(
        element.x,
        element.y,
        element.text,
        element.fontSize,
        element.align === "center" ? "middle" : element.align === "right" ? "end" : "start",
      );
    case "station":
      return textBox(
        element.x,
        element.y,
        element.crs ? `${element.name} [${element.crs}]` : element.name,
        element.fontSize,
        "middle",
      );
    case "boundary":
      return union(
        around(element.x, element.y, 8),
        textBox(element.x + 8, element.y + 4, element.name, 10, "start"),
      );
    case "platformNumber":
      return fromRect(platformNumberGeometry(element).box, 30);
    case "bufferStop":
      return fromRect(bufferStopBounds(element));
    case "neutralSection": {
      const g = neutralSectionGeometry(element);
      return union(fromRect(g.board), placedText(g.label, element.label, element.fontSize));
    }
    case "levelCrossing": {
      const g = levelCrossingGeometry(element, "blank");
      const ends = [...g.road, ...g.barriers].flatMap((s) => [
        { x: s.x1, y: s.y1 },
        { x: s.x2, y: s.y2 },
      ]);
      return union(
        fromRect(pointsBounds(ends), 40),
        placedText(g.label, element.label, element.fontSize),
      );
    }
    case "switchedDiamond":
      return around(element.x, element.y, 80);
    case "trackPath":
    case "platform":
    case "route":
      return fromRect(pointsBounds(element.points), 20);
    case "tunnel":
    case "viaduct":
    case "water": {
      const bounds = pointsBounds(element.points);
      return union(
        fromRect(bounds, 40),
        placedText(placedLabelAnchor(bounds, element), element.label, element.fontSize),
      );
    }
    default:
      return null;
  }
}

/** Grid index of element bounds, so finding what to draw for a view checks only nearby cells. */
export interface CullIndex {
  /** Elements whose drawing may meet `box`, plus every element with unknown bounds. */
  query(box: Box): Set<string>;
}

const CELL = 1000;

export function buildCullIndex(
  elements: ReadonlyArray<MapElement>,
  berthRects: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): CullIndex {
  const cells = new Map<string, Array<{ id: string; box: Box }>>();
  const always: string[] = [];
  for (const element of elements) {
    const box = elementDrawBounds(element, berthRects.get(element.id));
    if (
      !box ||
      !Number.isFinite(box.minX + box.minY + box.maxX + box.maxY) ||
      // A drawing many cells across (a very long track) is cheaper to keep than to index.
      (box.maxX - box.minX) * (box.maxY - box.minY) > 400 * CELL * CELL
    ) {
      always.push(element.id);
      continue;
    }
    for (let cx = Math.floor(box.minX / CELL); cx <= Math.floor(box.maxX / CELL); cx += 1) {
      for (let cy = Math.floor(box.minY / CELL); cy <= Math.floor(box.maxY / CELL); cy += 1) {
        const key = `${cx},${cy}`;
        const list = cells.get(key);
        if (list) list.push({ id: element.id, box });
        else cells.set(key, [{ id: element.id, box }]);
      }
    }
  }
  return {
    query(view) {
      const found = new Set(always);
      for (let cx = Math.floor(view.minX / CELL); cx <= Math.floor(view.maxX / CELL); cx += 1) {
        for (let cy = Math.floor(view.minY / CELL); cy <= Math.floor(view.maxY / CELL); cy += 1) {
          for (const { id, box } of cells.get(`${cx},${cy}`) ?? []) {
            if (
              box.maxX >= view.minX &&
              box.minX <= view.maxX &&
              box.maxY >= view.minY &&
              box.minY <= view.maxY
            )
              found.add(id);
          }
        }
      }
      return found;
    },
  };
}

/** The least margin drawn beyond the view, in map units. On a narrow phone screen one window is
 * only ~550 units, so a steady drag reached the edge every few frames and redrew it each time
 * (measured: pan steps 3–4× slower than before culling). */
const MIN_MARGIN_X = 1000;
const MIN_MARGIN_Y = 600;
/** How close (map units) the view may come to the drawn region's edge before it is renewed. */
const MIN_SLACK_X = 300;
const MIN_SLACK_Y = 200;

function margins(view: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.max(view.width, MIN_MARGIN_X), y: Math.max(view.height, MIN_MARGIN_Y) };
}

/** The region drawn for a view: the view plus a window (at least `MIN_MARGIN_*`) on every side,
 * so an ordinary drag or zoom-out reaches no undrawn edge before the region is renewed. */
export function cullRegionFor(view: { x: number; y: number; width: number; height: number }): Box {
  const m = margins(view);
  return {
    minX: view.x - m.x,
    minY: view.y - m.y,
    maxX: view.x + view.width + m.x,
    maxY: view.y + view.height + m.y,
  };
}

/** Whether the drawn region needs renewing for this view: the view has come within half a window
 * (at least `MIN_SLACK_*`) of the region's edge, or zoomed so far in that the region is more
 * than twice the size a fresh one would be. */
export function needsRecull(
  region: Box | null,
  view: { x: number; y: number; width: number; height: number },
): boolean {
  if (!region) return true;
  const slackX = Math.max(view.width / 2, MIN_SLACK_X);
  const slackY = Math.max(view.height / 2, MIN_SLACK_Y);
  if (
    view.x - slackX < region.minX ||
    view.y - slackY < region.minY ||
    view.x + view.width + slackX > region.maxX ||
    view.y + view.height + slackY > region.maxY
  )
    return true;
  const fresh = cullRegionFor(view);
  return (
    region.maxX - region.minX > 2 * (fresh.maxX - fresh.minX) ||
    region.maxY - region.minY > 2 * (fresh.maxY - fresh.minY)
  );
}

/**
 * The region to draw next: a fresh one round the view, grown from the current region rather
 * than moved when the two together are at most 1.5 times a fresh one's size. A drag that goes
 * back and forth then keeps what it has already drawn instead of dropping and redrawing it.
 */
export function nextCullRegion(
  region: Box | null,
  view: { x: number; y: number; width: number; height: number },
): Box {
  const fresh = cullRegionFor(view);
  if (!region) return fresh;
  const grown = union(region, fresh);
  return grown.maxX - grown.minX <= 1.5 * (fresh.maxX - fresh.minX) &&
    grown.maxY - grown.minY <= 1.5 * (fresh.maxY - fresh.minY)
    ? grown
    : fresh;
}
