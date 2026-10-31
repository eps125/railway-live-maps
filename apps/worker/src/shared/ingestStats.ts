export interface IngestStatsLogger {
  /** Call once per processed frame, right after it's durably recorded and acked. `receivedAt`
   * is the frame's own arrival time (set the moment it came off the socket, in
   * shared/connection/stomp/stompConnection.ts) and `newestNormalizedEventAtUtc` is
   * `RecordBrokerFrameResult`'s field of the same name (null for an already-recorded/redelivered
   * frame, or one with no children). `brokerTimestampMs` is the broker's own `timestamp` header,
   * when it sent one: how far behind the broker this process is (2026-10-31). */
  record(
    receivedAt: Date,
    newestNormalizedEventAtUtc: string | null,
    brokerTimestampMs?: number | null,
  ): void;
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
export interface IngestStatsHooks {
  /** More text for the stats line (e.g. ordered-insert timings); null for none. */
  extra?: () => string | null;
  /** Called once per window with its worst broker lag (null when no frame carried a broker
   * timestamp), e.g. to record the recorder falling behind (td/ingestLagAlarm.ts). */
  onWindow?: (maxBrokerLagMs: number | null) => void;
}

export function createIngestStatsLogger(
  feedName: string,
  logIntervalMs: number = DEFAULT_LOG_INTERVAL_MS,
  hooks: IngestStatsHooks = {},
): IngestStatsLogger {
  let frameCount = 0;
  let processingMsSum = 0;
  let maxMessageLagMs = 0;
  let maxBrokerLagMs: number | null = null;

  const timer = setInterval(() => {
    const windowSeconds = Math.round(logIntervalMs / 1000);
    if (frameCount === 0) {
      console.log(`${feedName} ingest stats (last ${windowSeconds}s): 0 frames`);
    } else {
      const avgProcessingMs = Math.round(processingMsSum / frameCount);
      const maxLagSeconds = Math.round(maxMessageLagMs / 1000);
      const broker =
        maxBrokerLagMs === null ? "" : `, max broker lag ${Math.round(maxBrokerLagMs / 1000)}s`;
      const extra = hooks.extra?.();
      console.log(
        `${feedName} ingest stats (last ${windowSeconds}s): ${frameCount} frames, ` +
          `avg processing ${avgProcessingMs}ms, max end-to-end lag ${maxLagSeconds}s` +
          broker +
          (extra ? `, ${extra}` : ""),
      );
    }
    hooks.onWindow?.(maxBrokerLagMs);
    frameCount = 0;
    processingMsSum = 0;
    maxMessageLagMs = 0;
    maxBrokerLagMs = null;
  }, logIntervalMs);
  // Never keep the process alive on this timer alone — it's diagnostic logging, not a reason
  // to delay shutdown.
  timer.unref?.();

  return {
    record(receivedAt, newestNormalizedEventAtUtc, brokerTimestampMs) {
      const nowMs = Date.now();
      if (typeof brokerTimestampMs === "number" && Number.isFinite(brokerTimestampMs)) {
        const brokerLagMs = Math.max(0, nowMs - brokerTimestampMs);
        if (maxBrokerLagMs === null || brokerLagMs > maxBrokerLagMs) maxBrokerLagMs = brokerLagMs;
      }
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
