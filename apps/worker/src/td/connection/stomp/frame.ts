/**
 * Milestone 7: the STOMP 1.2 codec is broker-protocol-generic (no TD-specific content ever
 * lived here), so it moved to `apps/worker/src/shared/connection/stomp/frame.ts` for reuse by
 * VSTP/TRUST. This re-export keeps existing imports (and `frame.test.ts`, which still tests
 * the same implementation) working unchanged.
 */
export * from "../../../shared/connection/stomp/frame.js";
