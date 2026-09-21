# ADR 0015 — Crossing position inferred from protecting signals; realistic barriers by default

- **Status:** accepted
- **Date:** 2026-09-21
- **Milestone:** 59
- **Amends:** [ADR 0014](0014-level-crossing-barriers-from-s-class.md) (decision 1, and its Milestone 58 addendum)

## Context

ADR 0014 made a crossing's barrier position come from one bound S-Class crossing (LXC) bit or
nothing, and listed "infer barriers from the signals protecting the crossing" under _Alternatives
rejected_. Its own investigation then found that some areas publish signals but no crossing bit at
all — M9, which carries the Blackpool line's Carleton crossing, publishes signals and routes only.

The owner asked for three things on 2026-09-21:

1. The realistic barrier drawing (Milestone 58, previously unbound crossings only) as the
   **default for every crossing**, bound or not, with a **raised** pose to go with the lowered one.
2. Crossings drivable three ways: undriven (no S-Class coverage), by an LXC bit (ADR 0014), or
   **inferred** from protecting signals where there is signal but no LXC coverage. The owner's
   example: Carleton, from S3879 (M9 07:4) and S3870 (M9 06:6) — "because if the signal is off I
   know the crossing must be down".
3. For unbound crossings, no change: always drawn lowered.

## Decision

**1. A crossing may be inferred from its protecting signals — an owner-approved reversal of the
rejected alternative in ADR 0014.** A new binding type, `tdSBitBarrierInferred`, lists input
signal bits, each with what a set bit means _for that signal_ (the signal's on/off vocabulary,
verified per input exactly as ADR 0013 requires). The rule is fixed (`inferredBarrierState`):

| inputs                                   | crossing |
| ---------------------------------------- | -------- |
| any input signal off (at proceed)        | down     |
| every input signal confirmed on (danger) | up       |
| otherwise (an input unknown, none off)   | blank    |

Each input is resolved by the existing signal machinery — per-binding polarity, the five-minute
feed-gap trust, the lookback window — under a synthetic element id, so nothing about reading a bit
is reimplemented. A crossing has at most one barrier source: an LXC bit, an inferred rule, or
nothing (`validateMapDocument`: `multiple_barrier_bindings`; the editor's `setBinding` replaces all
of an element's bindings, so switching source cannot leave both).

The owner's rule as first written — `if (07:4) or (06:6) == 0 then raised` — would have shown
raised whenever _one_ signal was at danger, i.e. nearly always, since normally only one direction
is signalled at a time. The owner restated it as "both signals at danger = raised, either one at
proceed = lowered", which is what is implemented.

**2. The `up` half of the rule is the owner's explicit choice, and it is knowingly wrong for part
of every cycle.** The `down` half is guaranteed by the railway: a protected crossing's signal will
not clear until the barriers are down and proven. The `up` half is not. The barriers lower and
prove _before_ a signal clears — ADR 0014 measured that gap on M9 at 40-90 s, never under 25 s —
and stay down _after_ it returns to danger until the train has passed. In both windows an inferred
crossing shows raised while the barriers are physically down. This was put to the owner, with that
measurement, before implementation; the owner chose raised over showing unknown between trains.
The editor states it beside the inputs, and the site remains labelled non-safety-critical and
unofficial (CLAUDE.md rule 16).

**3. Realistic is the default drawing for every crossing; the schematic lines become the opt-out**
(`schematicBarriers`, replacing Milestone 58's opt-in `realisticBarriers`, which now has no
effect). Position is shown by **pose**, never colour: `up` draws the arms raised, `down` lowered.

**4. An unknown crossing is drawn lowered, in full colour** (owner decision). This covers an
unbound crossing (as before), a bound crossing whose bit is not currently trustworthy, and an
inferred crossing in the blank case. In the realistic style it is therefore indistinguishable from
a genuinely lowered crossing — the owner preferred that to a greyed or raised treatment. It errs on
the safe side (it never suggests a road is clear). The schematic style keeps ADR 0014's
grey-means-no-information unchanged.

**5. The raised pose stands both arms upright on screen** (owner design, 2026-09-21), including
the barrier below the track, whose raised arm then crosses the track — the natural reading of a
raised boom seen from an angle. Each folded skirt faces the carriageway. This applies to the
realistic style only; the schematic `up` keeps its 2026-09-20 away-from-the-railway geometry.

## Consequences

- ADR 0014's Milestone 58 addendum — realistic barriers only on unbound crossings, mutually
  exclusive with a binding, `realistic_barriers_on_bound_crossing` — is **superseded**: with a
  raised pose, a bound crossing can show its live position in the realistic style, so the
  exclusion had no remaining purpose. The validation error is removed.
- ADR 0014 decision 1 still holds for a crossing with an LXC bit: that crossing shows its bit and
  nothing else. It no longer holds for every crossing, because an inferred crossing's position is,
  by design, derived from signals.
- CLAUDE.md rule 10 ("never infer signal state from ... adjacent signals") is untouched: no
  _signal's_ state is inferred. A crossing's position is inferred _from_ signals' states, each of
  which is still only its own bound bit.
- One state rule, three producers, all sharing `inferredBarrierState`:
  - **Snapshot** (`sClassStatesForBundle`: live, `/state?at=`, editor Test mode) — inputs resolve
    alongside real signals in the one `computeSignalStates` call, then combine.
  - **Playback** (`fetchSignalPlaybackEvents`) — a `td_s_event` row restates only the bytes it
    carries, but inputs can sit in different bytes, so each page seeds every input's state as of its
    first row with the snapshot's own resolver, then folds forward row by row, resetting inputs to
    unknown at each receive silence exactly where the stream blanks.
  - **Live** (`projector-td-live`) — a per-process memory of each input's last state, falling back
    to `td_s_current_state` as seeded at the last binding reload, so a restart doesn't leave a
    crossing unknown until its signals are next restated (areas refresh only every ~2 hours).
- The wire protocol is unchanged: an inferred crossing emits ordinary `crossing.updated` messages
  with absolute state, carrying the triggering input's address/bit.
- `map_binding_index` gains `td_s_bit_barrier_input` rows, one per input (migration 0040), in the
  signal vocabulary. The same bit may be both a drawn signal's `td_s_bit` row and a crossing's
  input row in one map version.
- A compiled bundle gains an optional `inferredBarrierBindings`; a bundle published before this has
  none, and reads exactly like an empty one (rule 11).

## Alternatives rejected

- **Show unknown rather than raised between trains.** Correct at every moment, recommended, and
  declined by the owner in favour of a more informative display (decision 2).
- **Grey the arms for unknown in the realistic style.** Would keep ADR 0014's grey-means-unknown
  convention; declined by the owner (decision 4).
- **Reference signal elements rather than bits.** Would reuse a signal's verified binding, but
  would force the protecting signals to be drawn on the map to infer the crossing. Bits keep the
  crossing independent of what else is drawn.
- **Combine the inputs in the client.** Would leave the server simple, but every API consumer
  would have to reimplement the rule, and the snapshot would no longer state the crossing's
  position. One server-side rule keeps a single authority.
