export interface IngestStatsLogger {
  /** Call once per processed frame, right after it's durably recorded and acked. `receivedAt`
   * is the frame's own arrival time (set the moment it came off the socket, in
   * shared/connection/stomp/stompConnection.ts) and `newestNormalizedEventAtUtc` is
   * `RecordBrokerFrameResult`'s field of the same name (null for an already-recorded/redelivered
   * frame, or one with no children). */
  record(receivedAt: Date, newestNormalizedEventAtUtc: string | null): void;
  /** Stops the periodic timer. Long-running ingest commands never call this in practice (the
   * process itself keeps running until killed) — it exists for tests. */
  stop(): void;
}

const DEFAULT_LOG_INTERVAL_MS = 30_000;

/**
 * Periodic throughput/lag logging for the ingest-* commands (docs/ARCHITECTURE.md's "storage
 * observability" requirement, CLAUDE.md's engineering rules). Without this, a healthy
 * connection's container logs show nothing past the one-time "session started" line.
 *
 * Ticks on a real timer, not just when a frame arrives — logging *only* on frame arrival would
 * make a connection that's alive but genuinely has nothing to receive (VSTP is documented as
 * going quiet for extended stretches — see the openraildata-talk thread on feed connections
 * hanging) indistinguishable from one that's silently dead: both would produce zero log lines.
 * Ticking regardless means "0 frames" is a real, distinct, intentional statement — "still
 * connected, feed's just quiet" — instead of the absence of any output at all.
 *
 * Reports two distinct numbers when frames did arrive, not just one "lag": `avg processing` is
 * time spent inside *this* process (received off the socket -> durably archived+indexed+acked) —
 * if that's small while `max end-to-end lag` stays large, the delay is happening before the
 * frame even reaches this process (upstream of the STOMP connection), not in this archive/index
 * pipeline. That distinction is what a live ~5-minute TD lag investigation actually needed.
 */
export function createIngestStatsLogger(
  feedName: string,
  logIntervalMs: number = DEFAULT_LOG_INTERVAL_MS,
): IngestStatsLogger {
  let frameCount = 0;
  let processingMsSum = 0;
  let maxMessageLagMs = 0;

  const timer = setInterval(() => {
    const windowSeconds = Math.round(logIntervalMs / 1000);
    if (frameCount === 0) {
      console.log(`${feedName} ingest stats (last ${windowSeconds}s): 0 frames`);
    } else {
      const avgProcessingMs = Math.round(processingMsSum / frameCount);
      const maxLagSeconds = Math.round(maxMessageLagMs / 1000);
      console.log(
        `${feedName} ingest stats (last ${windowSeconds}s): ${frameCount} frames, ` +
          `avg processing ${avgProcessingMs}ms, max end-to-end lag ${maxLagSeconds}s`,
      );
    }
    frameCount = 0;
    processingMsSum = 0;
    maxMessageLagMs = 0;
  }, logIntervalMs);
  // Never keep the process alive on this timer alone — it's diagnostic logging, not a reason
  // to delay shutdown.
  timer.unref?.();

  return {
    record(receivedAt, newestNormalizedEventAtUtc) {
      const nowMs = Date.now();
      frameCount += 1;
      processingMsSum += nowMs - receivedAt.getTime();
      if (newestNormalizedEventAtUtc) {
        const lagMs = nowMs - new Date(newestNormalizedEventAtUtc).getTime();
        if (lagMs > maxMessageLagMs) maxMessageLagMs = lagMs;
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}
