import { StompConnection } from "../../../shared/connection/stomp/stompConnection.js";
import type { InboundBrokerFrame } from "../../../shared/recordBrokerFrame.js";
import type { BrokerConnectionOptions } from "../../../shared/connection/brokerConnection.js";
import type {
  VstpConnection,
  VstpConnectionOptions,
  VstpConnectionState,
} from "../vstpConnection.js";

export interface StompConnectionConfig {
  host: string;
  port: number;
  topic: string;
  username: string;
  password: string;
  heartbeatMs?: number;
}

/** Milestone 7: thin VSTP-specific wrapper over the shared STOMP client, same pattern as
 * `td/connection/stomp/stompConnection.ts`'s `StompTdConnection`. */
export class StompVstpConnection implements VstpConnection {
  private readonly inner: StompConnection;

  constructor(config: StompConnectionConfig) {
    this.inner = new StompConnection({ ...config, feedName: "VSTP" });
  }

  get state(): VstpConnectionState {
    return this.inner.state;
  }

  async start(options: VstpConnectionOptions): Promise<void> {
    // Safe: the wrapped StompConnection was constructed with feedName: "VSTP" fixed, so every
    // frame it hands to onFrame is genuinely an InboundVstpFrame — the type system just can't
    // see that guarantee through the shared connection's wider InboundBrokerFrame signature.
    return this.inner.start(options as unknown as BrokerConnectionOptions<InboundBrokerFrame>);
  }

  async stop(): Promise<void> {
    return this.inner.stop();
  }
}
