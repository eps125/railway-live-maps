/**
 * Keeps a long-running ingest command's process alive (mirrors the old `return new
 * Promise<never>(() => {})` every ingest-* command used) but, unlike that, actually reacts to
 * `SIGTERM`/`SIGINT` — the signals Docker/Portainer send on every ordinary container
 * stop/restart/redeploy. Without this, the process was simply killed with the broker connection
 * still open at the TCP level: `StompConnection.stop()` (and the STOMP DISCONNECT it now sends,
 * see stomp/stompConnection.ts) never ran, so Network Rail's broker never learned the session had
 * ended cleanly. Exits the process itself once shutdown finishes (or after a bounded grace
 * period, so a hung `stop()` can't wedge the container past Docker's own SIGKILL timeout).
 */
const SHUTDOWN_GRACE_MS = 5000;

export function runUntilShutdownSignal(stop: () => Promise<void>): Promise<never> {
  return new Promise<never>(() => {
    const shutdown = (signal: NodeJS.Signals): void => {
      console.log(`received ${signal}, closing broker connection before exit`);
      const timeout = setTimeout(() => {
        console.error(`shutdown did not finish within ${SHUTDOWN_GRACE_MS}ms, exiting anyway`);
        process.exit(0);
      }, SHUTDOWN_GRACE_MS);
      timeout.unref?.();
      void stop()
        .catch((error: unknown) => console.error("error while closing broker connection", error))
        .finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}
