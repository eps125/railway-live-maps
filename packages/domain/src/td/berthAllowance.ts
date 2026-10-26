/**
 * Milestone 97a (docs/adr/0021): a berth's normal occupancy time, the "berth allowance" the
 * held-train delay estimate subtracts before counting a stand as delay.
 *
 * Outliers (a train stood for hours, a stabled unit, a TD glitch) are removed with a Tukey fence,
 * dropping anything longer than `Q3 + 1.5 × (Q3 − Q1)`. The allowance is the 95th percentile of
 * what's left, never under one minute. On production (PX, 17–23 October 2026) this turned BLDM's
 * 189-minute outlier into a 6.2-minute allowance, where a plain 99th percentile gave 13.
 *
 * A berth with fewer than `BERTH_ALLOWANCE_MIN_SAMPLES` occupancies isn't measured: it gets
 * `BERTH_ALLOWANCE_DEFAULT_MINUTES`, which errs towards showing less delay.
 */
export const BERTH_ALLOWANCE_MIN_SAMPLES = 50;
export const BERTH_ALLOWANCE_DEFAULT_MINUTES = 3;
export const BERTH_ALLOWANCE_FLOOR_MINUTES = 1;
const ALLOWANCE_PERCENTILE = 0.95;

export type BerthAllowance =
  | {
      basis: "measured";
      sampleSize: number;
      dropped: number;
      medianMinutes: number;
      q1Minutes: number;
      q3Minutes: number;
      fenceMinutes: number;
      allowanceMinutes: number;
    }
  | { basis: "default"; sampleSize: number; dropped: 0; allowanceMinutes: number };

/** Linear-interpolated percentile of an ascending array, the same as Postgres
 * `percentile_cont`. */
export function percentileOfSorted(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) throw new Error("percentileOfSorted: empty input");
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

/** `durationsMinutes`: how long each occupancy of the berth lasted. Negative or non-finite values
 * (clock skew between the entry and exit events) are ignored, not repaired. */
export function berthAllowance(durationsMinutes: readonly number[]): BerthAllowance {
  const sorted = durationsMinutes
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0)
    .sort((a, b) => a - b);
  if (sorted.length < BERTH_ALLOWANCE_MIN_SAMPLES) {
    return {
      basis: "default",
      sampleSize: sorted.length,
      dropped: 0,
      allowanceMinutes: BERTH_ALLOWANCE_DEFAULT_MINUTES,
    };
  }
  const q1 = percentileOfSorted(sorted, 0.25);
  const median = percentileOfSorted(sorted, 0.5);
  const q3 = percentileOfSorted(sorted, 0.75);
  const fence = q3 + 1.5 * (q3 - q1);
  const kept = sorted.filter((minutes) => minutes <= fence);
  const p95 = percentileOfSorted(kept, ALLOWANCE_PERCENTILE);
  return {
    basis: "measured",
    sampleSize: sorted.length,
    dropped: sorted.length - kept.length,
    medianMinutes: median,
    q1Minutes: q1,
    q3Minutes: q3,
    fenceMinutes: fence,
    allowanceMinutes: Math.max(BERTH_ALLOWANCE_FLOOR_MINUTES, p95),
  };
}
