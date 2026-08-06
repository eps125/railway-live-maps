/**
 * Milestone 7: reconnect backoff math is broker-protocol-generic, moved to
 * `apps/worker/src/shared/connection/backoff.ts` for reuse by VSTP/TRUST. This re-export keeps
 * existing imports (and `backoff.test.ts`) working unchanged.
 */
export * from "../../shared/connection/backoff.js";
