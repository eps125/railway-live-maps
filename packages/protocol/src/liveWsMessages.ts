import { z } from "zod";

/** Milestone 6 (docs/API_CONTRACT.md §2): `GET /api/v1/maps/{slug}/live` wire format.
 * Bump this if any message shape changes incompatibly — clients can then refuse to interpret
 * an unexpected version rather than silently misreading deltas. */
export const LIVE_PROTOCOL_VERSION = 1;

/** Milestone 9: matches apps/api/src/lib/liveState.ts's `RunSummary` exactly — `text` and
 * `trainRunId` are only ever set when `status === "matched"` and real TRUST/resolver data
 * supplies them, never fabricated (docs/PROJECT_SPEC.md §5). `trainRunId` (added 2026-08-11)
 * lets a client track this specific run across berth steps rather than re-deriving identity from
 * the four-character description alone (CLAUDE.md rule 5). */
const RunSummarySchema = z
  .object({
    status: z.enum(["matched", "ambiguous", "unmatched"]),
    text: z.string().nullable(),
    trainRunId: z.string().nullable(),
  })
  .nullable();

/** A berth's state within a full snapshot — vacant berths are represented (nulls), unlike
 * `berth.updated` deltas which are only ever emitted for an occupied berth. */
const SnapshotBerthStateSchema = z.object({
  description: z.string().nullable(),
  enteredAt: z.string().nullable(),
  runSummary: RunSummarySchema,
});

const SignalStateSchema = z.object({
  state: z.enum(["blank", "on", "off"]),
});

/** Matches apps/api/src/lib/mapVersion.ts's `liveDataStatus` return values exactly. */
const QualityStateSchema = z.object({
  status: z.enum(["ok", "stale", "unknown"]),
  gaps: z.array(z.string()),
});

/** Same shape as the `state` body of `GET /api/v1/maps/{slug}/state` (docs/API_CONTRACT.md §1),
 * minus the envelope fields (`mapSlug`/`mapVersion`/`asOf`) which are implicit in the socket
 * connection itself. */
export const LiveSnapshotStateSchema = z.object({
  mode: z.literal("live"),
  quality: QualityStateSchema,
  berths: z.record(z.string(), SnapshotBerthStateSchema),
  signals: z.record(z.string(), SignalStateSchema),
});
export type LiveSnapshotState = z.infer<typeof LiveSnapshotStateSchema>;

export const SnapshotMessageSchema = z.object({
  type: z.literal("snapshot"),
  protocolVersion: z.literal(LIVE_PROTOCOL_VERSION),
  sequence: z.number().int().nonnegative(),
  state: LiveSnapshotStateSchema,
});
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;

/** Only ever emitted for an occupied berth — an empty berth is `berth.cleared` instead, so
 * `description`/`enteredAt` are required here, unlike the snapshot's per-berth shape. */
export const BerthUpdatedMessageSchema = z.object({
  type: z.literal("berth.updated"),
  sequence: z.number().int().nonnegative(),
  eventAt: z.string(),
  elementId: z.string(),
  tdArea: z.string(),
  berth: z.string(),
  description: z.string(),
  enteredAt: z.string(),
  // Still never resolved per-delta here — a berth step fires the instant td_berth_event is
  // written, before the resolver (its own decoupled loop) can have decided anything about the
  // new occupancy yet. Every producer sends `null`; run.resolution.updated is what carries a
  // real RunSummary once the resolver actually decides.
  runSummary: RunSummarySchema,
});
export type BerthUpdatedMessage = z.infer<typeof BerthUpdatedMessageSchema>;

export const BerthClearedMessageSchema = z.object({
  type: z.literal("berth.cleared"),
  sequence: z.number().int().nonnegative(),
  eventAt: z.string(),
  elementId: z.string(),
  tdArea: z.string(),
  berth: z.string(),
});
export type BerthClearedMessage = z.infer<typeof BerthClearedMessageSchema>;

export const QualityUpdatedMessageSchema = z.object({
  type: z.literal("quality.updated"),
  sequence: z.number().int().nonnegative(),
  eventAt: z.string(),
  quality: QualityStateSchema,
});
export type QualityUpdatedMessage = z.infer<typeof QualityUpdatedMessageSchema>;

/** Synthesized directly by the WS route on a fixed timer — never produced by a
 * `LiveDeltaSource` — so clients can distinguish "still connected, nothing changed" from a
 * dead connection. */
export const HeartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  sequence: z.number().int().nonnegative(),
  eventAt: z.string(),
});
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;

/** Synthesized directly by the WS route (sequence-gap detection is the client's job per
 * docs/API_CONTRACT.md §2; the server only knows about a map-version change or its own
 * recovered error) — never produced by a `LiveDeltaSource`. Deliberately has no `sequence`:
 * it tells the client to discard its stream state and reconnect, not to keep counting. */
export const ResyncRequiredMessageSchema = z.object({
  type: z.literal("resync.required"),
  reason: z.enum(["sequence_gap", "map_version_changed", "server_error_recovered"]),
});
export type ResyncRequiredMessage = z.infer<typeof ResyncRequiredMessageSchema>;

/** Emitted by apps/worker/src/mapProjector/projector.ts whenever a resolution decided on
 * `berth_run_resolution` (added 2026-08-11) is still the current occupancy of its berth —
 * `berth.updated`/`berth.cleared` fire the instant a berth steps, before the resolver (its own
 * decoupled loop) has necessarily decided anything, so `runSummary` on those is only ever a
 * best-effort snapshot value; this is what keeps it live in between. */
export const RunResolutionUpdatedMessageSchema = z.object({
  type: z.literal("run.resolution.updated"),
  sequence: z.number().int().nonnegative(),
  eventAt: z.string(),
  elementId: z.string(),
  runSummary: RunSummarySchema,
});
export type RunResolutionUpdatedMessage = z.infer<typeof RunResolutionUpdatedMessageSchema>;

export const LiveWsMessageSchema = z.discriminatedUnion("type", [
  SnapshotMessageSchema,
  BerthUpdatedMessageSchema,
  BerthClearedMessageSchema,
  QualityUpdatedMessageSchema,
  HeartbeatMessageSchema,
  ResyncRequiredMessageSchema,
  RunResolutionUpdatedMessageSchema,
]);
export type LiveWsMessage = z.infer<typeof LiveWsMessageSchema>;

/** The subset of message types a `LiveDeltaSource` implementation actually produces/forwards
 * (each carries a `sequence`) — excludes `snapshot` (sent once, directly by the route),
 * `heartbeat` and `resync.required` (both synthesized directly by the route, not sourced from
 * projected state). */
export type LiveDeltaMessage =
  BerthUpdatedMessage | BerthClearedMessage | QualityUpdatedMessage | RunResolutionUpdatedMessage;
