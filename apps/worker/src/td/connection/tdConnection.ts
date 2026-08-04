import type { InboundFrame } from "../recorder.js";

export interface TdFrameHandle {
  frame: InboundFrame;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

export interface TdConnectionOptions {
  onFrame: (handle: TdFrameHandle) => Promise<void>;
  /** Returns the new feed_connection_session id — every implementation records one. */
  onSessionStart: (session: { clientId: string; connectedAt: Date }) => Promise<string>;
  onSessionEnd: (info: { sessionId: string; disconnectReason: string; at: Date }) => Promise<void>;
  onError?: (error: Error) => void;
}

export type TdConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "auth-failed" | "stopped";

export interface TdConnection {
  readonly state: TdConnectionState;
  start(options: TdConnectionOptions): Promise<void>;
  stop(): Promise<void>;
}
