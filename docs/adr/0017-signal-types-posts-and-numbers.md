# ADR 0017 — Signal types, posts, direction and signal numbers

- **Status:** accepted (owner, 2026-09-27)
- **Date:** 2026-09-27
- **Amends:** CLAUDE.md rule 9 (colours per signal type); ADR 0005 E4 (signal render modes)

## Context

Today every signal is one kind: a 12 px round head drawn on the track (or, optionally, ADR 0005
E4's perpendicular "offset" stem, which the owner never uses). Its state is only the bound bit —
`blank` / `on` / `off`, drawn grey / red / green (CLAUDE.md rules 9 and 10). The map cannot show
which direction a signal applies to, cannot show subsidiary or distant signals as such, and has no
practical way to show signal numbers.

The owner asked (2026-09-26/27) for subsidiary and distant signal types, a post that shows
direction, movable signal numbers visible to admins, and an editor tool to name and orient
signals in bulk.

Research (sources in the conversation record): UK WestCAD was designed to look like IECC, and
SimSig — which reproduces IECC/WestCAD closely — draws a main signal as a roundel on an L-shaped
post beside the track, foot at the approach end, head towards the direction of travel. A
subsidiary is a quarter-disc (grey unlit, white when off); a ground shunt signal is a quarter-disc
on its own post (red on, white off). SimSig shows colour-light distants yellow when on and green
when off (a simulator convention; not confirmed for real WestCAD or MCS). NX panels (Preston,
Swindon) show red for on and green for every off aspect. MCS (Alstom, ex-Vaughan Harmon/GE) has no
public symbology and is described as IECC-like.

## Decision

### 1. Signal types and colours (amends rule 9)

`signal` gains `signalType: "main" | "subsidiary" | "distant"` (default `main`). The state is still
only the bound bit's `blank` / `on` / `off`; the type chooses the colour each state is drawn in,
following the panel conventions above:

| type       | blank | on     | off   |
| ---------- | ----- | ------ | ----- |
| main       | grey  | red    | green |
| subsidiary | grey  | red    | white |
| distant    | grey  | yellow | green |

Yellow on a distant means "this distant's bit says on" — never a predicted or calculated aspect.
Nothing is ever derived from neighbouring signals, routes or train movements (rule 10 unchanged).
Rule 9 is reworded to: "Signals use only `blank`, `on` and `off`, each drawn in its signal type's
colours (main red/green, subsidiary red/white, distant yellow/green). Never calculate or claim
aspects such as single or double yellow."

### 2. Post (replaces ADR 0005 E4's modes)

A signal with a direction (below) is drawn on an L-shaped post: from the track edge, a stem rises
9 units away from the track, then an arm runs 4 units in the direction the signal applies to,
touching the head — no gaps. Track 3 units wide, stem 2 units.

- **Main and distant:** the current 12-unit round head (radius 6) at the end of the arm.
- **Subsidiary:** a quarter-circle 12 units wide and tall (radius 12). Its flat edge faces the
  track; the arm meets the middle of the other flat edge; the curve leads in the direction of
  travel. Its bottom lines up with a main head's, so mains and subsidiaries sit at one level.
  For the opposite direction the whole shape is rotated 180°.
- A combined main + subsidiary on one post is a later extension; the drawing leaves room for it.

`renderMode` (`inline` / `offset`) is retired: the editor stops offering it, and it is ignored
for a signal that has a direction. **A signal with no direction yet renders exactly as today** —
published maps (Preston, Blackpool) look the same until their signals are given directions.

### 3. Direction and side

`signal` gains `appliesTo: "right" | "left"` (the direction of travel it applies to — not "faces",
which is ambiguous) and `side: "above" | "below"` (which side of the track the post stands). The
existing numeric `orientation` stays for older documents and is no longer used for signals.

Default rule (owner, 2026-09-27): a signal to the right of a berth on its track goes **above,
applying to right-running trains**; a signal to the left of a berth goes **below, applying to
left-running trains**. "Nearest berth" is the nearest berth box edge on the same track within 40
units. A signal exactly between two, or with no berth within 40, is left for the author. On
Carlisle as drawn this settles 265 of 281 signals. Either value can be overridden per signal.

### 4. Signal numbers

- The existing `label` holds the number. `labelOffset: { x, y }` (optional; the same shape the
  editor's other movable labels use) moves it, as an offset from the signal; absent means the
  default place — along the band beside the berth the signal protects, ending at the
  post.
- One fixed size, 6 units. Numbers are not drawn when zoomed out beyond where 6 units is legible.
- Public map: numbers are in the published data but drawn only for admins, behind a
  "Signal numbers" checkbox (remembered per browser). Making them public later is a code change
  to that condition. The editor always shows them.
- The author keeps numbers and heads clear of berths; the editor does not police overlap.

### 5. Bulk signal tool (editor)

One dialog for the whole map, with a preview before anything changes, applied as one undoable
editor step:

- **Names:** a signal bound (`tdSBit`) to a bit whose S-Class definition has a label takes that
  label. Optional prefix override replaces the label's leading letters (`S001` + `CE` →
  `CE001`); a label with no leading letters is used unchanged. Applies to every signal type.
- **Direction and side:** set by the default rule in section 3.
- **Provenance:** each signal records whether its name and its direction/side came from the tool
  or were set by hand (`labelSource`, `orientationSource`: `tool` | `custom`). The tool always
  re-applies over its own earlier values; it replaces hand-set ones only if "Overwrite names I set
  by hand" / "Overwrite directions I set by hand" is ticked (both off by default). Editing a name
  or direction by hand marks it `custom`.
- The preview lists what will change and what is skipped and why (hand-set; not bound; bit has no
  label; no berth nearby; exactly between two berths).
- Applied through a new editor command, `patchElements` (many elements, one undo step).

## Consequences

- `packages/map-schema`: `signal` gains `signalType`, `appliesTo`, `side`, `labelOffset`,
  `labelSource`, `orientationSource` — all optional, `schemaVersion` stays 1. Shared geometry for
  the post, heads and default label position, used by both renderers (rule 13).
- `MapRenderer.tsx` and `EditorCanvas.tsx` draw the new shapes and colours; the public map gains
  the admin-only numbers checkbox; the editor gains the property fields, label dragging and the
  bulk tool.
- No database migration, no API change: the fields travel in the canonical document and compiled
  bundle.
- CLAUDE.md rule 9 is reworded as above.

## Alternatives considered

- **A separate subsidiary element type** — rejected: the same post, binding and number handling
  apply; a type field keeps one code path and allows a combined post later.
- **Stripping numbers from the data for non-admins** — not needed: signal numbers are not
  sensitive (owner, 2026-09-27).
- **Wider track spacing so numbers read at normal zoom** — not pursued; small numbers readable
  when zoomed in are acceptable.
- **Keeping ADR 0005 E4's perpendicular stem** — rejected: it adds clutter without showing
  direction.

## Revision — 2026-09-27 (owner, after running the tool on Blackpool)

- **Smaller heads and posts (option "C"):** head radius 5 (was 6), rise 7 (was 9), arm 3 (was 4);
  a subsidiary's quarter-circle is 10 wide, still matching a main head. One signal now reaches
  13.5 units from its track, so two signals — one from each track — fit in the 30-unit gap
  between tracks at the same point.
- **No distant marker:** a triangle on the post was drawn and dropped; distants are shown by
  their yellow/green head, and the owner marks them in the signal number.
- **Berth resize in the bulk tool:** a "Resize berths to 40 wide" option (on by default) makes
  every berth 40 wide about its centre; a signal next to a trimmed berth end moves in with it
  (nearest box edge on its own track within 40, on the side its direction implies), keeping its
  gap to the box. A berth already 40 wide is left alone, so running the tool again changes
  nothing more.

## Revision — 2026-09-27 (owner): stop boards and the cut-out

- **Stop board (`signalType: "stopBoard"`):** for depots. From the owner's photo: a white board,
  a red disc, and "Stop" in black below it. It has **no post**: the board lies along the track, 1
  unit from its edge, 13 long (a post and head) and 9.5 deep, turned ±90° so the disc **leads** in
  the direction it applies. `appliesTo`/`side` work as for any signal, and so does the number. It
  has no state: it is always drawn in its own colours, so no colour on it is an aspect or a bit
  (rule 9 as amended is untouched). Drawn in the level crossing's realistic palette.
- **Cut-out:** every signal on a post, and every stop board, is drawn over a 0.75-unit border in
  the map background colour (`#0d1117`) round its post and head, so it stays clear where it
  stands over a platform. The owner chose 0.75 after seeing 1 ("a little too much") and 2. The
  cut-out starts at the track edge, like the post, so the track itself is never cut.
