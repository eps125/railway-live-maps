export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the exponential delay randomized in either direction. */
  jitterRatio?: number;
}

/** Pure and injectable-random so reconnect backoff is deterministically testable regardless
 * of which STOMP client implementation is behind the TdConnection interface. */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.2;

  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}
