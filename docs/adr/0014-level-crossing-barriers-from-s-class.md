# ADR 0014 — Level crossing barrier position from S-Class

- **Status:** accepted — amended by [ADR 0015](0015-inferred-crossing-state-and-realistic-default.md) (2026-09-21): decision 1 no longer holds for every crossing (an owner-configured crossing may be inferred from its protecting signals), and the Milestone 58 addendum is superseded (realistic barriers are the default for every crossing).
- **Date:** 2026-09-20
- **Milestone:** 55
- **Extends:** [ADR 0013](0013-s-class-decoding-and-signal-binding.md)

## Context

The owner asked for a level crossing tool, and for optional "barriers up / barriers down"
indications "that can optionally be set and driven by S class data".

ADR 0013 established how a signal's displayed state is derived: one author-bound S-Class bit, a
per-binding statement of what a set bit means, a five-minute feed-gap trust tolerance, and
nothing else — never inferred from movements, routes, timetables or neighbouring signals
(CLAUDE.md rule 10). Barriers are a second thing driven by the same feed, so the question is
whether they reuse that machinery or get their own.

## Decision

**1. A barrier's position comes only from one bound S-Class bit, on exactly the terms ADR 0013
set for signals.** An unbound crossing, a crossing whose byte has no trustworthy recent value,
and a binding with no recorded `activeMeans` all display `blank`. `blank` means "no
information"; it must never be read, rendered or documented as "up". Nothing about train
movements, berth steps, routes or timetables ever contributes.

**2. Barriers are not signal aspects.** CLAUDE.md rule 9 constrains what a _signal_ may display
(blank/on/off, red = on, green = off, never a calculated yellow). A barrier position is a
different physical thing and rule 9 does not apply to it — but the spirit does: only positions
actually stated by a bound bit are shown, and nothing is interpolated. Red = down and green = up
are chosen because the road is blocked or clear, not as aspects.

**3. The state machinery is reused verbatim, the vocabulary is not.** `computeSignalStates` is
not really signal-specific: it resolves "one bound bit" into "one of two states, or blank when
nothing trustworthy is known", handling feed-gap trust, the live overlay and the lookback
window. A barrier is exactly that shape. Reimplementing it for barriers would duplicate subtle,
already-correct logic and let the two drift, so barriers call the same function, converting at
the edges:

| barrier | signal machinery             |
| ------- | ---------------------------- |
| `down`  | `on` (the restrictive state) |
| `up`    | `off`                        |
| `blank` | `blank`                      |

The conversion lives in `barrierActiveMeansAsSignal` / `barrierStateFromSignalState`
(`packages/domain/src/td/signalState.ts`) and nowhere else. Signals and crossings for one map
resolve in a **single** call (`sClassStatesForBundle`), so they cannot be computed against
different facts or a different `at`.

**4. A barrier binding is its own binding type, not a widened signal binding.** `tdSBitBarrier`
carries `activeMeans: "up" | "down"`. Widening `tdSBit.activeMeans` to four values was
rejected: it would weaken ADR 0013's invariant that a signal binding states an aspect, and would
let a barrier bit be silently consumed as a signal bit. The separation is enforced in the
database (migration 0039: `binding_type` and `active_means` are checked together, so a barrier
row cannot claim `on`/`off` and a signal row cannot claim `up`/`down`) and in
`validateMapDocument` (a barrier binding only on a `levelCrossing`; at most one per crossing).

**5. The author states what the bit means, per crossing, and verifies it.** Exactly as for
signals: never assumed, never defaulted to something plausible. The editor's binding panel says
so.

## Consequences

- Live, `/state?at=`, snapshots and playback all show barriers, by construction: they share one
  resolution path, so rule 13 holds without a second implementation to keep in step. Playback
  emits `crossing.updated` alongside `signal.updated` from the same paged stream, including the
  blank-on-silence rule.
- **Historical barrier state is blank until an area's S-Class history has been decoded**
  (recorded 2026-09-20, after Milestone 56 found this while investigating "replay shows no
  signals"). `fetchSByteFactsAt` only reads `td_s_event` rows with `decode_status = 'decoded'`,
  and every row predating Milestone 36a is `raw_only`, so a window before an area was decoded or
  backfilled has no facts to resolve against. Inherited by barriers unchanged: `resolveSignalStates`
  initialises every element to blank and overwrites only on a trusted fact, so a crossing in such a
  window is grey rather than guessed — which is the correct outcome under decision 1, not a bug to
  be "fixed" by inferring a position. It is a coverage limit, not a resolution one: the same
  crossing resolves normally once its area is backfilled.
- `crossing.updated` carries absolute state, like `signal.updated`, so duplicate or replayed
  deltas are harmless.
- The wire's `crossings` record is optional: a client or server that predates crossings keeps
  working, and a missing record reads as "no crossings", never as "up".
- Published map versions stay immutable (rule 11). A bundle compiled before this ADR has no
  `barrierBindingIndex`; every reader must treat that exactly like an empty one.
- Barrier state is **not** projected into its own table. It is derived from `td_s_event` on
  demand, the same as signal state, so there is nothing new to rebuild (rule 3) and no new
  retention concern.
- A crossing can be drawn without ever being bound. That is the expected common case: the road
  symbol is useful on its own, and grey barriers say plainly that nothing is known.

## Finding and verifying a barrier bit

Decision 5 requires the author to state what a bit means and verify it, but says nothing about
_how_. This is the method, established empirically against M9 on 2026-09-20 by the concurrent
Milestone 56 session and recorded here so it does not have to be re-derived. `backfill-s-class-bits
--area XX` gives 14 days of decoded history for a candidate area in roughly 12 minutes, which is
what makes this tractable.

The test that works is **state invariance, not transition correlation**. A crossing must be proved
down before either protecting signal can clear, so a genuine crossing bit is in the same state at
_every_ clear of _both_ protecting signals.

1. **Establish polarity empirically, per area.** Correlate a signal bit's transitions to 0 against
   CA berth steps out of that signal's own berth, within ±10s. In M9 that gave 52/52 and 45/46 at
   0s median offset, establishing that a set bit meant the signal was off. Never assume it.
2. **Compute each bit's duty cycle.** M9 split cleanly into controlled signals (~5-12% set) and
   automatics (~89% set); a bit outside those bands is a candidate for something else.
3. **Sample each bit ~2s before every clear of _both_ protecting signals.** A real crossing bit is
   invariant across all of them.

Two traps, both of which produced convincing false positives:

- **A bit set 89% of the time is invariant across 97 clears by chance alone.** Weight by duty
  cycle — check `pow(duty, n)` — or every automatic signal looks like a crossing.
- **Route bits mimic a crossing for a single signal.** M9's best candidates, `0C/4` (51/51 of
  S3879's clears) and `0C/2` (46/46 of S3870's), were direction-specific, roughly 1:1 with their
  own signal's clear count, and only 17% overlapping. A crossing is one physical thing serving both
  directions, so it must be invariant for **both** signals; splitting the test per signal is what
  exposed them.

A confirming signature for a real crossing: the delay between the route bit setting and the signal
clearing never fell below 25s and clustered at 40-90s, and did not track the train's arrival (median
267s after it, IQR 469s). That gap is the crossing lowering and proving.

Note that this sequence is observable **even in an area that publishes no crossing bit at all** —
which is precisely why it must never be rendered as barrier state. Inferring a position from the
signal sequence is what decision 1 forbids, and it would be most tempting exactly where no bit
exists.

Finally, whether a feed carries crossing bits at all appears to be a per-signaller-area property,
not a national one: M9 was confirmed to publish signals and routes only. Establish that an area
publishes crossing state before spending time trawling it.

## Alternatives rejected

- **Infer barriers from the signals protecting the crossing.** Directly against rule 10, and
  wrong in practice (a barrier can be down with the protecting signal still on). (Reversed by the
  owner for areas without LXC coverage — [ADR 0015](0015-inferred-crossing-state-and-realistic-default.md) — with the "wrong in practice"
  half recorded there as a known, accepted limitation.)
- **A manual, author-set barrier state.** Would put a static claim about a live, safety-adjacent
  thing on a public map. Grey-when-unbound is honest; a hardcoded "up" is not. (Still rejected —
  the Milestone 58 addendum below adds a fixed _drawing style_, not a settable state, and says why
  the two differ.)
- **One generic "bit-bound element" abstraction over signals and crossings.** Tempting, but it
  would have meant rewriting deployed, working signal code to gain nothing the edge conversion
  does not already give.

## Addendum — realistic barriers (Milestone 58, 2026-09-21) — superseded by ADR 0015

> Superseded the same day by [ADR 0015](0015-inferred-crossing-state-and-realistic-default.md): with a raised pose added, realistic is the default for every crossing, bound or not, and the mutual exclusion below (with its `realistic_barriers_on_bound_crossing` error) was removed. Kept for the record.

**Owner request and approval, 2026-09-21:** an optional "realistic crossing barriers" drawing — red
and white banded arms lowered across the road, a white picket skirt beneath, an asphalt road with
a white centreline — offered **only on a crossing with no S-Class binding**, and drawn **always in
the down position** (owner: "draw them in the down position, that's fine, no issues").

This sits close to the rejected "manual, author-set barrier state" above, so the distinction is
recorded rather than left implicit:

1. **It is a drawing style, not a state.** There is no up/down choice for an author to make and no
   state value in the document or the geometry — `realisticLevelCrossingGeometry` takes no state
   argument at all. The rejected alternative was a settable claim about where the barriers are.
2. **It can only appear where there is no state to contradict.** Offered only on an unbound
   crossing; the editor refuses to bind one while the style is on, `validateMapDocument` makes the
   combination unpublishable (`realistic_barriers_on_bound_crossing`), and the public renderer
   falls back to the live state if one ever arrives. A bound crossing's display remains exactly
   decision 1's: its bit, and nothing else.
3. **The fixed pose errs on the safe side.** The objection recorded above was to a hardcoded "up",
   which could suggest a road is clear when it is not. A picture of lowered barriers never
   suggests that. It is also the geometry an unbound crossing already used (grey, track-parallel,
   owner preference 2026-09-20), so the style changes the paint, not the pose.
4. **It uses none of the state colours.** The red is the arm's paint (`realistic.armRed`), not
   `stateColors.down`; the green that means "up" never appears.

What this does _not_ change: grey still means "no information" for a schematic crossing, a bound
crossing still shows only its bit, and nothing here infers a barrier position from anything
(rule 10). The site remains labelled non-safety-critical and unofficial (rule 16).
