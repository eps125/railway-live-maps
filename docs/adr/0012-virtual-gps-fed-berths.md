# ADR 0012 — Virtual (GPS-fed) berths for track with no TD coverage

## Status

**Accepted and implemented — 2026-09-19.** Ingestion path confirmed and unblocked the same day
(see "Ingestion — resolved" below): garner's own source (`trustdb.c`, `eps125/openrail-eps`) was
read directly and found to never capture `original_data_source` at all; patched (commit
`b9f3538`, pushed to that repo's `main`) to pack it into spare bits of the existing `flags` column
instead of adding a new one, so no RLM migration or bridge change was needed for ingestion — only
a decoder update, landed in `packages/domain/src/trust/garnerMovement.ts`. The owner rebuilt and
redeployed the `trustdb` daemon against that commit the same day. Everything else in this ADR
(map-schema binding, migration 0035, `project-virtual-berths` daemon, editor authoring, live
rendering, `current-run` integration) was then implemented in full — see the Consequences section
for exactly what landed, what deviated from the original plan below, and what's still deferred.

## Context

Some sections of track carry no TD coverage at all — no berths, no `CA`/`CB`/`CC` events ever
occur there, nothing for CLAUDE.md rule 1's "raw with lineage" retention to even apply to, because
there is no TD data. The owner wants these sections representable on published maps anyway: a
"virtual" berth that shows a headcode stepping along, just as a real TD berth would, but driven by
TRUST movement evidence instead of TD events — and visually distinguished with a yellow border in
both the editor and the live map, so nobody mistakes it for a real TD-backed berth.

Specifically requested: powered by TRUST reports "of type GPS". Real trains fitted with
GPS-based reporting equipment send TRUST movement messages regardless of track-circuit/axle-
counter coverage — exactly the evidence this needs. Confirmed against the real message spec (the
owner fetched openraildata.com's Train Movement wiki page into this session, since
`wiki.openraildata.com` is blocked by this session's own network egress policy and I could not
fetch it myself): the STOMP frame's **header** carries `original_data_source`, one of `"GPS"`,
`"SDR"`, `"SMART"`, `"TOPS"`, `"TRUST DA"` — a wholly different field from the movement **body**'s
`event_source` (`"AUTOMATIC"` / `"MANUAL"`), which is the thing `packages/domain/src/trust/
garnerMovement.ts`'s `manual` bit already decodes. There is no existing concept of
`original_data_source` anywhere in this codebase.

Per ADR 0002, RLM no longer ingests TRUST directly from Network Rail's STOMP broker — TD is the
only feed RLM still ingests raw. TRUST is mirrored from garner's already-normalized
`openrail-eps` MariaDB (`trust_movement`, migration 0025), populated by `apps/worker/src/garner/
bridge.ts`'s `runGarnerTrustSync`. That sync currently selects only `trust_id, created, platform,
loc_stanox, actual_timestamp, gbtt_timestamp, planned_timestamp, timetable_variation,
next_report_stanox, next_report_run_time, flags` from garner's `trust_movement` row — no header
fields, because it reads garner's own already-parsed row, not the raw NR frame.

### Ingestion — resolved (2026-09-19, `eps125/openrail-eps` commit `b9f3538`)

The real answer turned out to be neither of the two guesses this ADR started with. Reading
`trustdb.c`'s `process_trust_0003` directly (the function garner uses to parse a TRUST Train
Movement message and insert it into `trust_movement`) showed it extracts exactly the fields RLM
already mirrors — `train_id`, `event_type`/`planned_event_type`, `platform`, `loc_stanox`,
`actual_timestamp`, `gbtt_timestamp`, `planned_timestamp`, `timetable_variation`, `event_source`,
`offroute_ind`, `train_terminated`, `variation_status`, `next_report_stanox`,
`next_report_run_time`, `correction_ind` — and nothing else. `original_data_source` (a STOMP frame
**header** field, not body) was never read, never stored, appears nowhere in the repository.
Grepping the whole `openrail-eps` tree for it confirmed this. So garner genuinely never captured
it — not a mirror gap, an upstream one.

The fix turned out to be smaller than either option this ADR originally offered:

- `jsmn_find_extract_token` (`jsmn.c`) searches the whole message object by field name regardless
  of nesting, which is _how_ `process_trust_0003` already reaches `msg_type` — itself a header
  field — despite the code's local variable being named `body`. So `original_data_source` was
  exactly as reachable as anything else already extracted; it just was never asked for.
- `trust_movement.flags` (`database.c`'s `CREATE TABLE trust_movement`) is `SMALLINT UNSIGNED` —
  16 bits — and only bits 0-7 are used by the layout `garnerMovement.ts` already documents. Bits
  8-10 were free, so `original_data_source` was packed there (0 = unknown/unset, 1 = SDR,
  2 = SMART, 3 = TOPS, 4 = TRUST DA, 5 = GPS) instead of adding a new column.

Consequence: **no garner schema change, no RLM migration, no RLM bridge-sync change** — RLM
already mirrors `trust_movement.flags` verbatim (`runGarnerTrustSync`, `apps/worker/src/garner/
bridge.ts`). The only RLM-side change needed for ingestion was extending the decoder,
`decodeTrustMovementFlags` in `packages/domain/src/trust/garnerMovement.ts`, with an
`originalDataSource` field — done in this change, unit-tested (`garnerMovement.test.ts`).

Patch pushed directly to `eps125/openrail-eps`'s `main` (owner instruction, 2026-09-19): a 13-line
addition to `process_trust_0003`, no schema migration. **This still needs the `trustdb` daemon
rebuilt and redeployed against that commit before any real report ever carries a non-zero value**
— until then, every mirrored row's `originalDataSource` decodes to `"unknown"`, exactly as it does
today, so nothing downstream can accidentally treat absence-of-redeploy as absence-of-GPS-coverage.

## Decision

### Binding, not a new element — reuse the existing element/binding split

`packages/map-schema/src/document.ts` already separates a berth's visual element from its data
source: a `berth` element carries `bindingId`, pointing into a separate `bindings[]` array typed as
a discriminated union (`TdBerthBindingSchema` today). A "virtual" berth is exactly a `berth`
element whose binding is a **new binding type**, not a new element kind and not a boolean flag on
the element — "is this berth virtual" is fully derivable from which binding type its `bindingId`
resolves to, everywhere (editor canvas, public renderer, validation), matching rule 13.

```ts
const VirtualBerthBindingSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  type: z.literal("virtualBerth"),
  // A set, not a single value — ADR 0006's Spike 2 already found a real TD berth can cover more
  // than one STANOX (PX 0491: 3), and there's no reason a virtual berth's physical location is
  // any more likely to be exactly one. Usually one entry in practice.
  stanoxes: z.array(z.string().min(1)).min(1),
});

export const MapBindingSchema = z.discriminatedUnion("type", [
  TdBerthBindingSchema,
  TdSBitBindingSchema,
  VirtualBerthBindingSchema,
]);
```

Additive; `schemaVersion` stays 1, same as every other binding-shape addition so far.

### Stepping model — evidence-derived, no owner-curated chain order

The owner's example (five stations in a row with no TD coverage) suggested some kind of authored
sequence, mirroring how ADR 0007's `td_area_boundary` needed owner-curated adjacency pairs because
TD gives no cross-area link. **Virtual berths don't have that problem** — every GPS-sourced
`trust_movement` row already carries its own `trust_id`, which is direct, not inferred, identity
(stronger than anything ADR 0006/0007's tiered resolver ever gets to work with). So stepping needs
no authored ordering at all:

1. A new GPS-sourced `trust_movement` row arrives for `trust_id` T at `loc_stanox` S.
2. If S matches a currently-published virtual berth binding's `stanoxes`: close **any other**
   currently-open `virtual_berth_occupancy` row for this same `trust_id` (nationwide lookup, not
   scoped to "the same chain" — there's no chain to scope to), `exit_reason = 'stepped_to_virtual'`.
3. Open (or re-affirm, if S is unchanged from the currently open row — a repeat/duplicate report)
   an occupancy at S for T.
4. If this report's `train_terminated` flag is true, close the just-(re)opened occupancy
   immediately, `exit_reason = 'terminated'` — TRUST itself is telling us the journey is over,
   never inferred from silence.

This is symmetrical and self-contained: five virtual berths in a row on the map "just work" as
GPS reports arrive at each one in turn, no author input beyond binding each berth to its own
STANOX(es).

### What is explicitly _not_ attempted in this first cut

- **No automatic handoff back to TD coverage.** When a train re-enters real TD coverage, nothing
  here watches for it and auto-clears the last virtual berth it held — TD has no `trust_id` to
  match against (only a headcode string), and guessing off headcode-only re-entry risks exactly
  the false-positive class CLAUDE.md rule 5 exists to prevent. A virtual occupancy instead clears
  only via: the next GPS step (above), `train_terminated`, or a manual admin clear (extending the
  existing per-berth manual-clear capability from Milestone 47 to virtual berths). If real usage
  shows this is a real gap (a virtual berth left "stuck occupied" until the next train coincidentally
  reports GPS from the exact same STANOX), that's a follow-up milestone with real incident evidence
  to design against — the same pattern this project has followed for every other resolver
  refinement (Milestones 43-46).
- **No playback/history for virtual berths yet.** `virtual_berth_occupancy` is retained
  (append-only, immutable rows) so a later milestone can extend snapshot/playback to include it
  cheaply, but wiring it into `reconstructMapStateAt`/`/events` is deliberately out of scope here —
  matching how TD's own live path (Milestone 6) shipped well before playback (Milestone 10).
- **No STP/schedule-tie-break logic.** There is nothing to tie-break — one `trust_id`, one
  candidate, always.

### Data model (proposed migration 0035)

```sql
-- Additive: whatever column name garner confirms. Placeholder shown; adjust once confirmed.
alter table trust_movement add column original_data_source text;

-- Widen map_binding_index for the new binding kind (td_area becomes optional; virtual berths
-- have no TD area at all).
alter table map_binding_index alter column td_area drop not null;
alter table map_binding_index add column stanox text;
alter table map_binding_index drop constraint map_binding_index_berth_fields_check;
alter table map_binding_index add constraint map_binding_index_berth_fields_check check (
  (binding_type = 'td_berth' and td_area is not null and berth is not null
     and address is null and bit is null and stanox is null)
  or
  (binding_type = 'td_s_bit' and td_area is not null and address is not null and bit is not null
     and berth is null and stanox is null)
  or
  (binding_type = 'virtual_berth' and stanox is not null and td_area is null
     and berth is null and address is null and bit is null)
);
alter table map_binding_index drop constraint map_binding_index_binding_type_check; -- widen enum
alter table map_binding_index add constraint map_binding_index_binding_type_check
  check (binding_type in ('td_berth', 'td_s_bit', 'virtual_berth'));
-- One row per (map_version, stanox) per virtual-berth binding entry (a binding with several
-- stanoxes produces several map_binding_index rows, same "one row per lookup key" shape td_berth
-- already uses for combined-berth groups).
create unique index map_binding_index_virtual_berth_unique
  on map_binding_index (map_version_id, stanox) where binding_type = 'virtual_berth';
create index map_binding_index_virtual_berth_lookup_idx
  on map_binding_index (stanox) where binding_type = 'virtual_berth';

create table virtual_berth_occupancy (
  id bigint not null default nextval('virtual_berth_occupancy_id_seq'),
  projection_version integer not null,
  stanox text not null,
  trust_id text not null,
  headcode text,  -- display only, from trust_activation_extra at entry time; never a join key
  entered_at timestamptz not null,
  left_at timestamptz,
  entry_trust_movement_id bigint not null references trust_movement (id),
  exit_trust_movement_id bigint references trust_movement (id),
  exit_reason text check (
    exit_reason in ('stepped_to_virtual', 'terminated', 'manual_clear', 'superseded')
  ),
  primary key (id, entered_at)
) partition by range (entered_at);
-- ... monthly partitions + default partition, same pattern as berth_occupancy (migration 0008).

create index virtual_berth_occupancy_stanox_idx
  on virtual_berth_occupancy (stanox, entered_at desc);
create index virtual_berth_occupancy_trust_id_idx
  on virtual_berth_occupancy (trust_id, entered_at desc);

create table virtual_berth_current_state (
  projection_version integer not null,
  stanox text not null,
  trust_id text,
  headcode text,
  occupancy_id bigint,
  occupancy_entered_at timestamptz,
  event_at timestamptz not null,
  source_trust_movement_id bigint not null references trust_movement (id),
  updated_at timestamptz not null default now(),
  primary key (projection_version, stanox),
  constraint virtual_berth_current_state_occupancy_fk
    foreign key (occupancy_id, occupancy_entered_at)
    references virtual_berth_occupancy (id, entered_at)
);
```

Deliberately **new, separate tables** rather than overloading `berth_occupancy`/
`berth_current_state`: those are keyed by `(td_area, berth_code)` throughout (index, FK, and every
existing query that reads them assumes it), and a virtual berth has neither. Mirrors the same
"new table set for a new identity concept" precedent ADR 0007 set with `train_run` rather than
bolting run identity onto `berth_occupancy`.

### Projector — `project-virtual-berths`

New checkpointed daemon (`apps/worker/src/virtualBerths/`, same `daemonLoop` pattern as every
other live-path projector), consuming `trust_movement` in `id` order (RLM-local monotonic,
avoiding any garner clock-skew concern — same reasoning migration 0031's own doc comment gives for
preferring `id` over `created`/`reported`), filtered to GPS-sourced rows whose `loc_stanox`
matches a currently-published virtual berth binding — a bounded lookup against
`map_binding_index where binding_type = 'virtual_berth'`, per the Milestone 15 standing rule that
every projector query is bounded or reads a rollup, never an unbounded scan. Implements the
stepping model above. Rebuildable from empty state via `--rebuild`, same acceptance bar as every
other projector.

### Live delta wire protocol

No new message type needed. `packages/protocol/src/liveWsMessages.ts`'s `BerthUpdatedMessage` /
`BerthClearedMessage` currently require `tdArea`/`berth`; both become optional, and an optional
`stanox` is added, so a virtual berth's delta carries `stanox` where a TD berth's carries
`tdArea`/`berth`. The client does **not** need an explicit `source` field on the wire — it already
holds the compiled map bundle's `bindings[]` (delivered once per map load), so
`MapRenderer.tsx`/`EditorCanvas.tsx` derive "is this element virtual" locally by looking up
`elementId` against the bundle's binding type, exactly the same way they already derive every
other static per-element rendering fact. `elementId` remains the actual client-side lookup key for
applying a delta, unchanged. `apps/api/src/live/pollingDeltaSource.ts` (and the Redis path) gain a
second source query against `virtual_berth_current_state` joined through `map_binding_index`,
unioned with the existing TD-sourced deltas. No `LIVE_PROTOCOL_VERSION` bump — additive/optional
fields, shipped with the matching client in the same change.

### Editor authoring

- `PropertyPanel.tsx`: the berth block's binding fields gain a "Virtual (GPS-fed, no TD
  coverage)" toggle. Off: today's TD area/berth fields, unchanged. On: a STANOX picker
  (autocomplete against `location_reference`, mirroring `useBindingAutocomplete.ts`'s existing
  pattern against nationwide TD data) in place of them.
- `ValidationPanel.tsx`: a warning (not blocking — the tool cannot prove the negative "this STANOX
  definitely has no TD coverage") when a virtual berth's STANOX has no `location_reference` entry,
  mirroring the existing "never observed" TD-binding warning.
- Rendering: a new `MAP_STYLE.berth.virtualBorderColor` token (proposed `#FFD400`, adjust to
  taste), applied as the berth `<rect>`'s stroke in both `MapRenderer.tsx` and `EditorCanvas.tsx`
  whenever the element's binding type is `virtualBerth` — border only, layered on top of the
  existing occupied/vacant fill styling, which stays exactly as today (rule 13).

### `current-run` integration

A virtual berth's occupancy already carries `trust_id` directly — there is no candidate set to
tie-break, so the whole ADR 0006/0007 tiered resolver is bypassed entirely for a virtual-berth
click: look up `virtual_berth_current_state` for the clicked STANOX, join `trust_activation.
cif_schedule_id` for that exact `trust_id`, and build `effective` detail with the same existing
schedule-detail code the resolver already uses. Reported as a new `matchBasis: "virtual_direct"` —
positioned outside the existing tier ranking in docs (it isn't inferred, so it isn't "stronger
evidence than `trust_activation`" in the same sense, it's a different kind of match entirely) but
always `matched` when garner has a schedule link for that `trust_id`, `unmatched` when it doesn't
(never `ambiguous` — there is exactly one `trust_id`, by construction). CLAUDE.md rule 7 still
holds: always exactly one of the three statuses, surfaced honestly.

### Docs to update alongside implementation

`docs/DATA_MODEL.md` (new §, binding type), `docs/MAP_EDITOR_SPEC.md` (authoring + yellow-border
style), `docs/API_CONTRACT.md` (WS field changes, `virtual_direct` matchBasis, STANOX search
endpoint), `docs/ARCHITECTURE.md` (new daemon), `docs/PROJECT_SPEC.md` (product-behavior mention),
`docs/IMPLEMENTATION_PLAN.md` (new milestone, referencing this ADR).

## Consequences

**Landed, as designed:**

- Migration 0035: no new `trust_movement` column after all (see "Ingestion — resolved" —
  `original_data_source` rides the existing `flags` column instead), `map_binding_index` widened
  to a third binding kind (nullable `td_area`, new `stanox` column, widened check constraints,
  partial unique/lookup indexes), two new tables (`virtual_berth_occupancy`, partitioned by
  `entered_at` like `berth_occupancy`; `virtual_berth_current_state`).
- `packages/map-schema`: new `virtualBerth` binding type (`stanoxes: string[]`), additive,
  `schemaVersion` unchanged; `compileMapDocument` gains `virtualBerthBindingIndex`
  (`stanox -> elementId`); `validateMapDocument` blocks two virtual bindings sharing a STANOX.
- `packages/domain/src/virtualBerths/stepping.ts`: the pure `decideVirtualBerthStep` decision
  function, fixture-tested (5 cases) — no owner-curated chain ordering, exactly as designed.
- New daemon `project-virtual-berths-daemon` (`apps/worker/src/virtualBerths/projector.ts`),
  checkpointed on `trust_movement.id` independently of every other projector, wired into worker
  command dispatch and `deploy/docker-compose.portainer.yml`. **Also** a one-shot
  `project-virtual-berths [--rebuild]` command (not in the original plan text, added to meet the
  same rebuildability bar `project-td` sets) — integration-tested (6 cases: bound/unbound STANOX,
  stepping, `train_terminated`, idempotent redelivery, `--rebuild`), not executed in this sandbox
  (no local Postgres — same limitation nearly every integration test in this codebase notes).
- Live protocol: `tdArea`/`berth` optional on `berth.updated`/`berth.cleared`, `stanox` added, no
  version bump — `pollingDeltaSource.ts` and `computeLiveState` (the WS snapshot) both extended to
  union virtual state in alongside TD. The Redis-backed `redisDeltaSource.ts`/`mapProjector`
  path was **not** extended to carry virtual berths — it already only proves itself via fakes in
  this codebase (no real Redis available), and the default polling path is what production
  actually runs; a real gap if `LIVE_WS_REDIS_PUBSUB_ENABLED` is ever turned on.
- `GET /api/v1/virtual-berths/{stanox}/current-run` (new route, same file as the TD one):
  `matchBasis: "virtual_direct"`, never `ambiguous`. Deliberately **smaller** than the TD route's
  `effective` — no docs/adr/0009 Change of Origin/Identity/Location tracking (see the route's own
  doc comment for why that layer is TD-specific). Integration-tested (5 cases), not executed here.
- Editor: a binding-mode toggle + STANOX field (autocomplete reusing the existing
  `GET /api/v1/places/search`, **not a new dedicated endpoint** — that search already covers
  STANOX nationwide, so a separate endpoint would have been pure duplication) on the berth
  property panel; yellow border (`MAP_STYLE.berth.virtualBorderColor`) shared by `MapRenderer.tsx`
  and `EditorCanvas.tsx` (rule 13). Unit-tested (MapRenderer, PropertyPanel).
- `pnpm run typecheck`, `pnpm run lint`, `prettier --check .` and the full non-integration test
  suite (84 files / 586 tests) all green.

**Deviated from the original plan text:**

- No owner-curated chain ordering was ever needed (confirmed as designed, not a deviation) — but
  the STANOX autocomplete reused an existing endpoint instead of a new one, and the rebuild
  command wasn't in the original decision section at all.

**Explicitly still out of scope, same as originally planned:**

- Automatic hand-off back to TD coverage on re-entry (closes only via the next GPS step, TRUST's
  own `train_terminated`, or — see below — a manual clear that isn't actually wired up yet).
- Playback/history for virtual berths (retained, append-only, but not read by
  `reconstructMapStateAt`/`/events`).

**New gap found only while implementing, not yet closed:** `virtual_berth_occupancy.exit_reason`
already has a `'manual_clear'` value in its check constraint, but **no route or editor UI actually
triggers it** — unlike a TD berth, which has a real manual-clear capability (Milestone 47). A
virtual berth stuck showing occupied (its owning train's GPS reporting having gone permanently
quiet mid-journey, say) currently has no operator escape hatch at all until the next GPS report
for that `trust_id` arrives somewhere. Worth a fast-follow once real virtual-berth traffic shows
whether this is a real problem. No `ValidationPanel` "never observed" warning for an unrecognised
STANOX either (the TD equivalent — Milestone 12 — needs a DB-backed nationwide-observation check
this pass didn't build for STANOX; only the schema-level duplicate-STANOX block exists).
