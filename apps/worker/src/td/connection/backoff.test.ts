import { describe, expect, it } from "vitest";
import { computeBackoffDelayMs } from "./backoff.js";

const noJitter = (): number => 0.5; // random() = 0.5 -> jitter term is exactly 0

describe("computeBackoffDelayMs", () => {
  it("grows exponentially with attempt number", () => {
    expect(computeBackoffDelayMs(0, { baseMs: 100 }, noJitter)).toBe(100);
    expect(computeBackoffDelayMs(1, { baseMs: 100 }, noJitter)).toBe(200);
    expect(computeBackoffDelayMs(2, { baseMs: 100 }, noJitter)).toBe(400);
    expect(computeBackoffDelayMs(3, { baseMs: 100 }, noJitter)).toBe(800);
  });

  it("caps at maxMs", () => {
    expect(computeBackoffDelayMs(10, { baseMs: 100, maxMs: 1000 }, noJitter)).toBe(1000);
  });

  it("clamps negative attempt numbers to the base delay", () => {
    expect(computeBackoffDelayMs(-5, { baseMs: 100 }, noJitter)).toBe(100);
  });

  it("keeps jitter within the configured ratio", () => {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = computeBackoffDelayMs(2, { baseMs: 100, jitterRatio: 0.2 }, () => random);
      // exponential = 400, jitter range is +/- 20% => [320, 480]
      expect(delay).toBeGreaterThanOrEqual(320);
      expect(delay).toBeLessThanOrEqual(480);
    }
  });

  it("never returns a negative delay", () => {
    const delay = computeBackoffDelayMs(0, { baseMs: 10, jitterRatio: 5 }, () => 0);
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});
