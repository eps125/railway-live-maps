# ADR 0013 — S-Class decoding, signal freshness and assisted bit identification

## Status

**Proposed — 2026-09-19.** Decision 5 amended by [ADR 0016](0016-set-routes-from-s-class.md) (2026-09-22): routes are now rendered from their own bound bits. Design decisions taken by the owner during Milestone 36 planning;
implementation tracked in `docs/IMPLEMENTATION_PLAN.md` Milestone 36 (36a-36d).

## Context

S-Class data (SF/SG/SH) has been captured nationwide since Milestone 3 but never decoded.
Milestone 33's Blackpool map (TD area M9) is the first map intended to show real signal on/off
state. Verified against production data on 2026-09-19 (M8, M9, R1-R4):

- SF = 1 byte at a hex address; SG = 4 bytes starting at the address, first byte first; SH = the
  final 4-byte refresh chunk, carrying real data. Bit 0 = LSB.
- Refreshes arrive roughly every 2h per area; ~5.1M S-Class messages/day nationwide (176 areas).
- A signal bit reports "not at most restrictive aspect" — set = off is the expected polarity, but
  not uniform enough in real data to assume globally.
- Published community definition tables use inconsistent byte radix (R3 hex, M8 decimal) and
  contain errors; M9 has no published table at all.

## Decisions

1. **Decode into per-byte state and nationwide bit transitions.** `td_s_current_state` becomes
   per-byte; `td_s_bit_transition` is populated for every area (CLAUDE.md rule 17), with a refresh
   that disagrees with current state recorded as a flagged transition, not silently absorbed.
2. **Freshness across feed gaps.** Last-known byte state is trusted across a TD feed gap of up to
   5 minutes (configurable). Beyond that, the area's bytes are `unknown` (rendered blank) until an
   SF covering the byte or the next refresh re-confirms them. This satisfies PROJECT_SPEC §8's
   "do not retain an old signal indication indefinitely" while avoiding hours of blank signals
   after routine short reconnects/redeploys.
3. **Polarity is per binding.** `tdSBit.activeMeans` stays authoritative; no global polarity rule.
4. **Rule 10 clarification — assisted identification is permitted at authoring time only.** The
   admin S-Class explorer may rank candidate bits for a signal by correlating bit changes with
   nearby C-Class berth steps. This is a tool for a human author to _identify which bit belongs to
   which signal_; its output is a suggestion the owner must confirm and bind explicitly. It never
   feeds runtime state: a displayed signal indication is always, and only, the value of its bound
   bit. Rule 10 ("never infer signal state from train movements…") is unchanged for runtime.
5. **Scope.** Only signal on/off is bound and rendered. Other element kinds (routes, points, track
   sections, TRTS, level crossings) are stored as bits and may be recorded in the definitions
   table with their kind, but rendering them — level crossings and routes are planned — requires
   a later milestone and ADR, and PROJECT_SPEC §10's exclusions stand until then.
6. **Definition imports declare their radix.** Importers never guess hex vs decimal byte numbering
   and report duplicates/conflicts instead of resolving them.

## Consequences

- A projection-version bump and full S-Class rebuild from `td_s_event`, sized and partitioned
  before enabling (~5M transition rows/day order of magnitude).
- A new live WS delta (`signal.updated`) and signal resolution in live state, reconstruction,
  snapshots and playback.
- A minimal feed-gap detector lands in M36 for signal freshness; Milestone 37 still owns general
  `feed_gap` row writing.
- M9 signal identification is owner work (36d), supported by the explorer.

## Implementation notes (2026-09-19)

- 36a deployed: decoding runs inside `project-td`; per-byte state is `projection_version = 2`.
- 36b: the gap policy is implemented from TD _receive_ times (nationwide `feed_gap` rows with
  `detection_reason = 'td_receive_silence'`), not the session table, which production does not
  populate reliably. Signal deltas go out from both live publishers, sorted by sequence with berth
  deltas; a `resync.required` (`feed_gap`) tells open maps to re-snapshot after a long silence.
  See `docs/IMPLEMENTATION_PLAN.md` 36b for the full as-built list.
