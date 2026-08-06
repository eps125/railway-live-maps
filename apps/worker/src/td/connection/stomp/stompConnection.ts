import { StompConnection } from "../../../shared/connection/stomp/stompConnection.js";
import type { InboundBrokerFrame } from "../../../shared/recordBrokerFrame.js";
import type { BrokerConnectionOptions } from "../../../shared/connection/brokerConnection.js";
import type { TdConnection, TdConnectionOptions, TdConnectionState } from "../tdConnection.js";

export interface StompConnectionConfig {
  host: string;
  port: number;
  topic: string;
  username: string;
  password: string;
  heartbeatMs?: number;
}

/**
 * Milestone 7: the STOMP client itself generalized into
 * `apps/worker/src/shared/connection/stomp/stompConnection.ts` (VSTP/TRUST reuse it with their
 * own `feedName`/topic). This is now a thin TD-specific wrapper — same config shape, same
 * behavior — so every existing caller (`commands/ingestTd.ts`) is unaffected.
 */
export class StompTdConnection implements TdConnection {
  private readonly inner: StompConnection;

  constructor(config: StompConnectionConfig) {
    this.inner = new StompConnection({ ...config, feedName: "TD" });
  }

  get state(): TdConnectionState {
    return this.inner.state;
  }

  async start(options: TdConnectionOptions): Promise<void> {
    // Safe: the wrapped StompConnection was constructed with feedName: "TD" fixed, so every
    // frame it hands to onFrame is genuinely an InboundFrame — the type system just can't see
    // that guarantee through the shared connection's wider InboundBrokerFrame signature.
    return this.inner.start(options as unknown as BrokerConnectionOptions<InboundBrokerFrame>);
  }

  async stop(): Promise<void> {
    return this.inner.stop();
  }
}
