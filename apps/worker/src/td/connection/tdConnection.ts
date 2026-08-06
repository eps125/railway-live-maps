import type { InboundFrame } from "../recorder.js";
import type {
  BrokerFrameHandle,
  BrokerConnectionOptions,
  BrokerConnectionState,
  BrokerConnection,
} from "../../shared/connection/brokerConnection.js";

/**
 * Milestone 7: generalized into `apps/worker/src/shared/connection/brokerConnection.ts` (VSTP/
 * TRUST reuse it too). These TD-specific aliases keep every existing import
 * (`fixtureReplayConnection.ts`, `stomp/stompConnection.ts`, `commands/ingestTd.ts`) unchanged.
 */
export type TdFrameHandle = BrokerFrameHandle<InboundFrame>;
export type TdConnectionOptions = BrokerConnectionOptions<InboundFrame>;
export type TdConnectionState = BrokerConnectionState;
export type TdConnection = BrokerConnection<InboundFrame>;
