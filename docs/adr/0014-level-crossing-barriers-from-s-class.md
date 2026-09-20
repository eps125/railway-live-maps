# ADR 0014 — Level crossing barrier position from S-Class

- **Status:** accepted
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

## Alternatives rejected

- **Infer barriers from the signals protecting the crossing.** Directly against rule 10, and
  wrong in practice (a barrier can be down with the protecting signal still on).
- **A manual, author-set barrier state.** Would put a static claim about a live, safety-adjacent
  thing on a public map. Grey-when-unbound is honest; a hardcoded "up" is not.
- **One generic "bit-bound element" abstraction over signals and crossings.** Tempting, but it
  would have meant rewriting deployed, working signal code to gain nothing the edge conversion
  does not already give.
