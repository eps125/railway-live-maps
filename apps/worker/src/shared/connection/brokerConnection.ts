/**
 * Milestone 7: generalized from `apps/worker/src/td/connection/tdConnection.ts` (which now
 * re-exports these under its original TD-specific names for compatibility) so VSTP/TRUST
 * connections share the same shape instead of each hand-rolling their own. Generic over the
 * frame type each feed's recorder module defines (`InboundFrame` in `td/recorder.ts`,
 * `vstp/recorder.ts`, `trust/recorder.ts`).
 */
export interface BrokerFrameHandle<TFrame> {
  frame: TFrame;
  ack(): Promise<void>;
  nack(): Promise<void>;
  /** Runs `fn` once every frame that arrived before this one on the same connection has run its
   * own (or been finished with), so whatever `fn` numbers follows arrival order while the rest
   * of each frame's handling stays concurrent (shared/connection/arrivalOrder.ts). Optional: a
   * connection that hands frames over one at a time needs none. */
  inArrivalOrder?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface BrokerConnectionOptions<TFrame> {
  onFrame: (handle: BrokerFrameHandle<TFrame>) => Promise<void>;
  /** Returns the new feed_connection_session id — every implementation records one. */
  onSessionStart: (session: { clientId: string; connectedAt: Date }) => Promise<string>;
  onSessionEnd: (info: { sessionId: string; disconnectReason: string; at: Date }) => Promise<void>;
  onError?: (error: Error) => void;
}

export type BrokerConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "auth-failed" | "stopped";

export interface BrokerConnection<TFrame> {
  readonly state: BrokerConnectionState;
  start(options: BrokerConnectionOptions<TFrame>): Promise<void>;
  stop(): Promise<void>;
}
