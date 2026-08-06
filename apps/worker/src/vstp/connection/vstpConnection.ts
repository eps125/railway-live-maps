import type { InboundVstpFrame } from "../recorder.js";
import type {
  BrokerFrameHandle,
  BrokerConnectionOptions,
  BrokerConnectionState,
  BrokerConnection,
} from "../../shared/connection/brokerConnection.js";

/** Milestone 7: VSTP-specific aliases over the shared generic broker connection types, same
 * pattern as `td/connection/tdConnection.ts`. */
export type VstpFrameHandle = BrokerFrameHandle<InboundVstpFrame>;
export type VstpConnectionOptions = BrokerConnectionOptions<InboundVstpFrame>;
export type VstpConnectionState = BrokerConnectionState;
export type VstpConnection = BrokerConnection<InboundVstpFrame>;
