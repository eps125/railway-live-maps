export interface DaemonLoopOptions {
  /** Human label for log lines. */
  label: string;
  /** Minimum time between the *start* of one tick and the next — if a tick itself takes longer
   * than this, the next tick starts immediately rather than stacking a wait on top. */
  intervalMs: number;
  /** Called once per tick. A thrown error is logged and the loop ticks again rather than the
   * process crashing — replaces the previous behaviour of a crashed one-shot `node` process being
   * restarted by the shell's `while` loop, but inside one long-lived process instead of paying a
   * fresh node startup (~0.5-1s) on every single cycle. */
  tick: () => Promise<void>;
  /** Called once, after the loop has stopped accepting new ticks, to release resources
   * (DB pools, Redis clients) before this function's promise resolves. */
  onShutdown?: () => Promise<void>;
}

/**
 * Long-running replacement for the `while true; do node dist/index.js <cmd>; sleep 1; done`
 * shell-loop pattern (`deploy/docker-compose.portainer.yml`'s `projector-*` services) — every
 * cycle of that pattern pays a full Node process startup, which is the dominant source of the
 * live map's end-to-end latency (2026-09 live-path hardening milestone,
 * docs/IMPLEMENTATION_PLAN.md). A daemon built on this keeps one process, one warm DB pool, and
 * can safely use a much shorter tick interval than the old `sleep 1` since there's no per-cycle
 * process-start tax to pay for it.
 *
 * Resolves (does not exit the process) once SIGTERM/SIGINT is received and the in-flight tick (if
 * any) completes — `onShutdown` then runs, and the caller's `main()` returns normally, letting the
 * process exit via Node's normal event-loop-drained behaviour rather than an explicit
 * `process.exit()` that could cut off `onShutdown`'s own async cleanup.
 */
export async function runDaemonLoop(options: DaemonLoopOptions): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    while (!stopping) {
      const startedAt = Date.now();
      try {
        await options.tick();
      } catch (error) {
        console.error(`${options.label}: tick failed`, error);
      }
      if (stopping) break;
      const elapsed = Date.now() - startedAt;
      const waitMs = Math.max(0, options.intervalMs - elapsed);
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (options.onShutdown) {
      await options.onShutdown();
    }
  }
}
