import { StompConnection } from "../../../shared/connection/stomp/stompConnection.js";
import type { InboundBrokerFrame } from "../../../shared/recordBrokerFrame.js";
import type { BrokerConnectionOptions } from "../../../shared/connection/brokerConnection.js";
import type {
  TrustConnection,
  TrustConnectionOptions,
  TrustConnectionState,
} from "../trustConnection.js";

export interface StompConnectionConfig {
  host: string;
  port: number;
  topic: string;
  username: string;
  password: string;
  heartbeatMs?: number;
}

/** Milestone 8: thin TRUST-specific wrapper over the shared STOMP client, same pattern as
 * `vstp/connection/stomp/stompConnection.ts`'s `StompVstpConnection`. */
export class StompTrustConnection implements TrustConnection {
  private readonly inner: StompConnection;

  constructor(config: StompConnectionConfig) {
    this.inner = new StompConnection({ ...config, feedName: "TRUST" });
  }

  get state(): TrustConnectionState {
    return this.inner.state;
  }

  async start(options: TrustConnectionOptions): Promise<void> {
    // Safe: the wrapped StompConnection was constructed with feedName: "TRUST" fixed, so every
    // frame it hands to onFrame is genuinely an InboundTrustFrame — see the identical cast in
    // vstp/connection/stomp/stompConnection.ts for the full explanation.
    return this.inner.start(options as unknown as BrokerConnectionOptions<InboundBrokerFrame>);
  }

  async stop(): Promise<void> {
    return this.inner.stop();
  }
}
