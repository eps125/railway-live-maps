import type { InboundTrustFrame } from "../recorder.js";
import type {
  BrokerFrameHandle,
  BrokerConnectionOptions,
  BrokerConnectionState,
  BrokerConnection,
} from "../../shared/connection/brokerConnection.js";

/** Milestone 8: TRUST-specific aliases over the shared generic broker connection types, same
 * pattern as `vstp/connection/vstpConnection.ts`. */
export type TrustFrameHandle = BrokerFrameHandle<InboundTrustFrame>;
export type TrustConnectionOptions = BrokerConnectionOptions<InboundTrustFrame>;
export type TrustConnectionState = BrokerConnectionState;
export type TrustConnection = BrokerConnection<InboundTrustFrame>;
