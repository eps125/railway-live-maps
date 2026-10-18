# WA (Warrington) S-Class decode — observed, 2026-10-13

Decoded from production data, 19 Sep – 13 Oct 2026: 93,000 WA bit changes against 304,000 WA
berth events (C-Class). Nothing here comes from a published table; every row is an observation.
This is an authoring aid (ADR 0013 decision 4): a displayed signal is only ever its bound bit.

WA carries S-Class for two fringe boxes only. Addresses `08`–`0E` are **St Helens**; `10`–`14`
are **Frodsham Junction** (Runcorn East and the Halton Curve junction). Addresses `00`–`07` and
`0F` never appear.

## How the bits behave

- **Polarity**: set = signal off (proceed); set = track circuit occupied; for points, one bit is
  normal and one reverse.
- **Every bit is held for about 12 seconds after it really drops.** A signal bit clears 12 s
  (±1 s, every time) after the track circuit just past it becomes occupied — the same instant as
  the berth step. In CL the signal bit drops at the step itself. So a WA signal will show "off"
  for about 12 s after the train has passed it.
- **Pairs**: each signal has a track-circuit bit that sets at the instant of the berth step out of
  that signal's berth. That pairing is what identifies both.

Confidence: **high** = matched 99%+ of 800–1,230 train passes; **medium** = consistent but few
observations or number inferred; **low** = behaviour seen, meaning uncertain.

## St Helens (`08`–`0E`)

Line 1, Thatto Heath → St Helens Central platform 1 → Garswood. In order:
`0D.5` → `0D.6` → **S101** → `0C.1` → `0C.2` → **S002** → `0C.3` → `0B.1` → **S003** → `0B.2` →
**S004** → `0B.3` → WN85.

Line 2, Garswood → St Helens Central platform 2 → Thatto Heath. In order:
**home** → `0C.0` → `0B.4` → `0B.5` (platform 2) → **S022** → `0B.6` → **S112** → `0C.4` →
`0C.6` → `0C.7`.

| Bit    | Kind   | Meaning                                                            | Evidence                                             | Confidence |
| ------ | ------ | ------------------------------------------------------------------ | ---------------------------------------------------- | ---------- |
| `08.1` | signal | S002 — platform 1 starter                                          | clears 12 s after S002>S003, 1,196 of 1,199          | high       |
| `08.2` | signal | S003                                                               | clears 12 s after S003>S004                          | high       |
| `08.3` | signal | S004                                                               | clears 12 s after S004>WN85                          | high       |
| `09.1` | signal | S022 — platform 2 starter                                          | clears 12 s after S022>S112, 1,216 of 1,220          | high       |
| `09.2` | signal | Home signal from Garswood into platform 2 (number not in the data) | clears 12 s after S022 is interposed, 1,215 of 1,220 | high       |
| `09.3` | signal | S101 — Thatto Heath                                                | clears 12 s after S101>S002, 1,196 of 1,199          | high       |
| `09.6` | signal | Goods loop exit towards S105 (probably S105's signal)              | 2 freight moves (6F92)                               | low        |
| `09.7` | signal | S106 — into the goods loop                                         | clears 12 s after S106>S111, 4 moves                 | medium     |
| `0A.1` | signal | S111 — goods loop exit                                             | clears 13 s after train leaves S111, 2 moves         | medium     |
| `0A.2` | signal | S112                                                               | clears 12 s after train leaves S112, 1,209 of 1,217  | high       |
| `0B.1` | track  | Between S002 and S003 (long section, ~100 s)                       | order in every pass                                  | high       |
| `0B.2` | track  | Just past S003                                                     | sets at S003>S004                                    | high       |
| `0B.3` | track  | Just past S004                                                     | sets at S004>WN85                                    | high       |
| `0B.4` | track  | Second after the home signal (line 2)                              | 22 s after `0C.0`                                    | high       |
| `0B.5` | track  | Platform 2                                                         | occupied ~105 s, clears after S022 passed            | high       |
| `0B.6` | track  | Just past S022                                                     | sets at S022>S112                                    | high       |
| `0C.0` | track  | Just past the home signal; triggers the S022 interpose             | sets at the interpose, 1,217 of 1,220                | high       |
| `0C.1` | track  | Just past S101                                                     | sets at S101>S002                                    | high       |
| `0C.2` | track  | Next after `0C.1` (platform 1 approach)                            | 7 s after `0C.1`                                     | high       |
| `0C.3` | track  | Just past S002                                                     | sets at S002>S003                                    | high       |
| `0C.4` | track  | Just past S112                                                     | 13 s before `0A.2` clears                            | high       |
| `0C.5` | track  | Goods loop (berth S111)                                            | sets with S106>S111 and loop departures              | medium     |
| `0C.6` | track  | Beyond S112, first                                                 | order in every pass                                  | high       |
| `0C.7` | track  | Beyond S112, second                                                | order in every pass                                  | high       |
| `0D.5` | track  | Approach from Huyton; triggers the S101 interpose                  | sets within 1 s of the interpose, 1,193 of 1,198     | high       |
| `0D.6` | track  | Approaching S101                                                   | follows `0D.5`, clears after S101 passed             | high       |
| `0E.2` | points | Goods loop points A — normal                                       | pair with `0E.3`; reversed for S112>S111             | medium     |
| `0E.3` | points | Goods loop points A — reverse                                      |                                                      | medium     |
| `0E.4` | points | Goods loop points B — normal                                       | pair with `0E.5`; reversed for S106/S111 moves       | medium     |
| `0E.5` | points | Goods loop points B — reverse                                      |                                                      | medium     |

`0E.0` is set and never changed in 24 days (possibly another points-normal that was never moved).
Not seen at all: `08.0`, `08.4`–`08.7`, `09.0`, `09.4`, `09.5`, `0A.0`, `0A.3`–`0A.7`, `0B.0`,
`0B.7`, `0D.0`–`0D.4`, `0D.7`, `0E.1`, `0E.6`, `0E.7`.

## Frodsham Junction (`10`–`14`)

Line A, Helsby → Runcorn East → Acton Grange: **FJ03** → `12.0` → **FJ05** → `12.2` → **FJ07** →
`12.3`.

Line B, Acton Grange → Runcorn East → Helsby: **FJ18** → `12.4` → **FJ16** → `12.5` → **FJ08** →
`12.6` → `12.7` → (junction) → `12.1` → `13.1` → **FJ04** → `13.0` → Helsby.

Halton Curve: single line, joins line B between `12.7` and `12.1`. `13.2` is its track circuit at
the junction, used in both directions. About 400 trains each way were seen; the WA describer only
describes the ones from Halton (interposed at FJ04).

| Bit    | Kind    | Meaning                                                                | Evidence                                          | Confidence |
| ------ | ------- | ---------------------------------------------------------------------- | ------------------------------------------------- | ---------- |
| `10.0` | signal  | FJ03                                                                   | clears 12 s after FJ03>FJ05, 824 of 825           | high       |
| `10.1` | unknown | Signal-like, two short pulses in 24 days (overnight possession)        | 10 Oct 23:40                                      | low        |
| `10.2` | signal  | FJ04                                                                   | clears 12 s after FJ04>HYLS, 1,232 of 1,235       | high       |
| `10.3` | signal  | FJ05 (normally left off; re-clears itself)                             | clears 12 s after FJ05>FJ07, 824 of 826           | high       |
| `10.4` | signal  | FJ06 — from the Halton Curve                                           | clears 12 s after FJ06>FJ04, 2 moves              | low        |
| `10.5` | signal  | FJ07 (normally left off; re-clears itself)                             | clears 12 s after FJ07>W254, 823 of 824           | high       |
| `10.6` | signal  | FJ08                                                                   | clears 12 s after FJ08>FJ04, 821 of 825           | high       |
| `11.0` | signal  | FJ16 (normally left off; re-clears itself)                             | clears 12 s after FJ16>FJ08, 816 of 822           | high       |
| `11.1` | signal  | FJ18 (normally left off; re-clears itself)                             | clears 12 s after FJ18>FJ16, 816 of 819           | high       |
| `11.2` | unknown | ~11 s pulse just before `11.3` clears (request or slot for the curve?) | precedes all 383 of its uses                      | low        |
| `11.3` | signal  | Junction signal from line A onto the Halton Curve (probably FJ11)      | clears 13 s after `13.2` occupied, 394 of 395     | medium     |
| `12.0` | track   | Just past FJ03                                                         | sets at FJ03>FJ05                                 | high       |
| `12.1` | track   | First past the junction towards FJ04                                   | used by line B and trains from Halton             | high       |
| `12.2` | track   | Just past FJ05                                                         | sets at FJ05>FJ07                                 | high       |
| `12.3` | track   | Just past FJ07                                                         | sets at FJ07>W254                                 | high       |
| `12.4` | track   | Just past FJ18                                                         | sets at FJ18>FJ16                                 | high       |
| `12.5` | track   | Just past FJ16                                                         | sets at FJ16>FJ08                                 | high       |
| `12.6` | track   | Just past FJ08                                                         | sets at FJ08>FJ04                                 | high       |
| `12.7` | track   | Line B, between FJ08 and the junction                                  | 17 s after `12.6`, line B trains only             | high       |
| `13.0` | track   | Just past FJ04                                                         | sets at FJ04>HYLS                                 | high       |
| `13.1` | track   | Approaching FJ04                                                       | 6 s after `12.1`                                  | high       |
| `13.2` | track   | Halton Curve at the junction (both directions)                         | 12 s before each FJ04 interpose, 412 of 413       | high       |
| `14.0` | unknown | Halton Curve → Helsby route held: sets 3 s after points reverse, stays | never set with FJ08 (`10.6`); set for every train | medium     |
|        |         | until they are put back. Behaves like a route, not an aspect.          | from Halton                                       |            |
| `14.1` | points  | Halton Curve junction points — normal                                  | pair with `14.2`; reverse for every curve train   | high       |
| `14.2` | points  | Halton Curve junction points — reverse                                 |                                                   | high       |
| `14.3` | points  | Second set of points — normal                                          | pair with `14.4`; moved twice, both overnight     | medium     |
| `14.4` | points  | Second set of points — reverse                                         |                                                   | medium     |

Not seen at all: `10.7`, `11.4`–`11.7`, `13.3`–`13.7`, `14.5`–`14.7`.

## Open questions

- The St Helens home signal (`09.2`) and the Halton Curve junction signal (`11.3`) have no number
  in the data; FJ11 is a guess from a berth of that name interposed twice.
- `11.2` and `14.0` are probably single-line working controls for the curve (a request or slot one
  way, a held route the other), not signal aspects.
- The goods loop rows rest on six freight moves.
- Unlike CL and M9, no route bits (`R…` style) were found in WA.
