/**
 * Pure TRUST run-lifecycle decision logic (docs/DATA_MODEL.md §7), mirroring
 * `td/berthReducer.ts`'s style: no DB I/O. The caller (`apps/worker/src/trust/projector.ts`)
 * looks up the current `train_run` snapshot (if any) for the relevant identity and passes it
 * in; this module only decides what should happen, returning effects the caller executes as
 * SQL. Schedule-link resolution (STP precedence lookup) is deliberately NOT a reducer effect —
 * it needs a DB round trip against `schedule`, so the projector performs it as its own step
 * after a `createRun` effect's insert returns the new run's id.
 */

export type TrainRunLifecycleState =
  "activated" | "unidentified" | "cancelled" | "completed" | "superseded";

export interface TrainRunSnapshot {
  id: string;
  lifecycleState: TrainRunLifecycleState;
}

export type TrustRunEffect =
  | {
      kind: "createRun";
      trustTrainId: string;
      serviceDate: string;
      signallingId: string | null;
      activatedAt: string | null;
      originDepartureAt: string | null;
      callType: string | null;
      callMode: string | null;
      operatorCode: string | null;
      serviceCode: string | null;
      lifecycleState: TrainRunLifecycleState;
      lastEventAt: string;
    }
  | {
      kind: "setLifecycleState";
      runId: string;
      lifecycleState: TrainRunLifecycleState;
      lastEventAt: string;
    }
  | { kind: "touchLastEventAt"; runId: string; lastEventAt: string }
  | {
      kind: "supersedeWithNewIdentity";
      oldRunId: string;
      newTrustTrainId: string;
      serviceDate: string;
      signallingId: string | null;
      operatorCode: string | null;
      serviceCode: string | null;
      lastEventAt: string;
    };

export interface TrustReducerResult {
  effects: TrustRunEffect[];
}

export interface ApplyActivationInput {
  trustTrainId: string;
  serviceDate: string;
  signallingId: string | null;
  activatedAt: string;
  originDepartureAt: string | null;
  callType: string | null;
  callMode: string | null;
  operatorCode: string | null;
  serviceCode: string | null;
  /** Set only when a `train_run` already exists for this (trustTrainId, serviceDate) —
   * activation redelivery/replay is a safe no-op, mirroring the TD projector's
   * already-projected-raw-event guard. */
  existingRun: TrainRunSnapshot | null;
}

/** Activation (msg_type 0001): creates the run. Redelivery of an activation for an
 * already-activated identity is a no-op — never double-creates. */
export function applyActivation(input: ApplyActivationInput): TrustReducerResult {
  if (input.existingRun) {
    return { effects: [] };
  }
  return {
    effects: [
      {
        kind: "createRun",
        trustTrainId: input.trustTrainId,
        serviceDate: input.serviceDate,
        signallingId: input.signallingId,
        activatedAt: input.activatedAt,
        originDepartureAt: input.originDepartureAt,
        callType: input.callType,
        callMode: input.callMode,
        operatorCode: input.operatorCode,
        serviceCode: input.serviceCode,
        lifecycleState: "activated",
        lastEventAt: input.activatedAt,
      },
    ],
  };
}

export interface RunLookupInput {
  run: TrainRunSnapshot | null;
  eventAt: string;
}

/** Movement (msg_type 0003): advances `last_event_at` only — no lifecycle change. A movement
 * with no matching run (e.g. arriving before its activation, a plausible real-world ordering
 * issue) is a defensive no-op: never fabricates a run from a movement alone. */
export function applyMovement(input: RunLookupInput): TrustReducerResult {
  if (!input.run) return { effects: [] };
  return {
    effects: [{ kind: "touchLastEventAt", runId: input.run.id, lastEventAt: input.eventAt }],
  };
}

/** Cancellation (msg_type 0002): moves the run to `cancelled`. */
export function applyCancellation(input: RunLookupInput): TrustReducerResult {
  if (!input.run) return { effects: [] };
  return {
    effects: [
      {
        kind: "setLifecycleState",
        runId: input.run.id,
        lifecycleState: "cancelled",
        lastEventAt: input.eventAt,
      },
    ],
  };
}

/** Reinstatement (msg_type 0006): moves a cancelled run back to `activated` — there is no
 * separate `reinstated` lifecycle value; the Reinstatement is itself the historical record
 * (its own `train_run_event` row), so nothing is lost by reusing `activated`. */
export function applyReinstatement(input: RunLookupInput): TrustReducerResult {
  if (!input.run) return { effects: [] };
  return {
    effects: [
      {
        kind: "setLifecycleState",
        runId: input.run.id,
        lifecycleState: "activated",
        lastEventAt: input.eventAt,
      },
    ],
  };
}

/** Change of Origin (msg_type 0007) / Change of Location (msg_type 0009): both only touch
 * `last_event_at` in this MVP — the detailed origin/location revision fields aren't modeled on
 * `train_run` beyond what activation captured; the full detail remains in `train_run_event`'s
 * `raw_event_json`, never lost. */
export function applyChangeOfOrigin(input: RunLookupInput): TrustReducerResult {
  if (!input.run) return { effects: [] };
  return {
    effects: [{ kind: "touchLastEventAt", runId: input.run.id, lastEventAt: input.eventAt }],
  };
}

export function applyChangeOfLocation(input: RunLookupInput): TrustReducerResult {
  if (!input.run) return { effects: [] };
  return {
    effects: [{ kind: "touchLastEventAt", runId: input.run.id, lastEventAt: input.eventAt }],
  };
}

export interface ApplyChangeOfIdentityInput {
  oldRun: TrainRunSnapshot | null;
  newTrustTrainId: string;
  serviceDate: string;
  signallingId: string | null;
  operatorCode: string | null;
  serviceCode: string | null;
  eventAt: string;
}

/** Change of Identity (msg_type 0008): the old identity is superseded, never rewritten in
 * place — its own history stays intact, and a new run is created under the revised identity.
 * A Change of Identity with no matching old run is a defensive no-op (can't supersede
 * something that was never created). */
export function applyChangeOfIdentity(input: ApplyChangeOfIdentityInput): TrustReducerResult {
  if (!input.oldRun) return { effects: [] };
  return {
    effects: [
      {
        kind: "supersedeWithNewIdentity",
        oldRunId: input.oldRun.id,
        newTrustTrainId: input.newTrustTrainId,
        serviceDate: input.serviceDate,
        signallingId: input.signallingId,
        operatorCode: input.operatorCode,
        serviceCode: input.serviceCode,
        lastEventAt: input.eventAt,
      },
    ],
  };
}

export interface ApplyUnidentifiedInput {
  trustTrainId: string;
  serviceDate: string;
  existingRun: TrainRunSnapshot | null;
  eventAt: string;
}

/** Unidentified Train (msg_type 0005): creates a minimal run with no schedule link when one
 * doesn't already exist for this identity; otherwise just advances `last_event_at`. */
export function applyUnidentified(input: ApplyUnidentifiedInput): TrustReducerResult {
  if (input.existingRun) {
    return {
      effects: [
        { kind: "touchLastEventAt", runId: input.existingRun.id, lastEventAt: input.eventAt },
      ],
    };
  }
  return {
    effects: [
      {
        kind: "createRun",
        trustTrainId: input.trustTrainId,
        serviceDate: input.serviceDate,
        signallingId: null,
        activatedAt: null,
        originDepartureAt: null,
        callType: null,
        callMode: null,
        operatorCode: null,
        serviceCode: null,
        lifecycleState: "unidentified",
        lastEventAt: input.eventAt,
      },
    ],
  };
}
