import { computeBackoffDelayMs, type BackoffOptions } from "./connection/backoff.js";

export interface RetryUntilDoneOptions {
  /** Names the operation in the retry log line, e.g. "TD frame record". */
  label: string;
  /** Checked after each failure; once true the last error is rethrown instead of retried (so a
   * shutdown isn't held open by an operation that can't currently succeed). */
  isStopped?: () => boolean;
  backoff?: BackoffOptions;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, error: unknown) => void;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 250, maxMs: 10_000 };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `operation` with capped exponential backoff until it succeeds (or `isStopped()`).
 * Only safe for idempotent operations. It exists so a live broker frame that has been received
 * but not yet stored is never dropped because of a transient failure.
 *
 * Production incident, 2026-09-23: under host I/O and memory pressure, ingest-td hit
 * `getaddrinfo EAI_AGAIN postgres` and pg-pool `connection timeout` errors 13 times in a day.
 * Each one escaped `onFrame` as an unhandled rejection and killed the process. That lost the
 * in-flight frame, and the TD subscription is not durable, so everything sent during the
 * ~6s restart was lost too. Every one of those errors cleared within seconds.
 */
export async function retryUntilDone<T>(
  operation: () => Promise<T>,
  options: RetryUntilDoneOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((message, error) => console.error(message, error));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (options.isStopped?.()) throw error;
      const delayMs = computeBackoffDelayMs(attempt, options.backoff ?? DEFAULT_BACKOFF);
      log(`${options.label} failed (attempt ${attempt + 1}); retrying in ${delayMs}ms:`, error);
      await sleep(delayMs);
    }
  }
}
