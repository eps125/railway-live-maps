import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIngestStatsLogger } from "./ingestStats.js";

describe("createIngestStatsLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T10:00:00.000Z"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it("logs '0 frames' on its own timer even when nothing was ever recorded", () => {
    const stats = createIngestStatsLogger("VSTP", 1000);
    vi.advanceTimersByTime(1000);
    expect(logSpy).toHaveBeenCalledWith("VSTP ingest stats (last 1s): 0 frames");
    stats.stop();
  });

  it("reports frame count, average processing time, and max end-to-end lag", () => {
    const stats = createIngestStatsLogger("TD", 1000);

    // Frame received 100ms before "now" -> 100ms processing time. Its content is 5s old.
    stats.record(new Date("2026-08-08T09:59:59.900Z"), "2026-08-08T09:59:55.000Z");
    vi.advanceTimersByTime(500);
    // A second frame, longer lag.
    stats.record(new Date("2026-08-08T10:00:00.300Z"), "2026-08-08T09:59:50.000Z");

    vi.advanceTimersByTime(500);
    // First frame: processed 100ms after receipt, content 5s old at the moment of recording.
    // Second frame (recorded 500ms later, at 10:00:00.500): processed 200ms after receipt,
    // content 10.5s old -> rounds to 11s, and is the larger of the two lags.
    expect(logSpy).toHaveBeenCalledWith(
      "TD ingest stats (last 1s): 2 frames, avg processing 150ms, max end-to-end lag 11s",
    );
    stats.stop();
  });

  it("resets counters between windows instead of accumulating forever", () => {
    const stats = createIngestStatsLogger("TD", 1000);
    stats.record(new Date(), null);
    vi.advanceTimersByTime(1000);
    logSpy.mockClear();

    vi.advanceTimersByTime(1000);
    expect(logSpy).toHaveBeenCalledWith("TD ingest stats (last 1s): 0 frames");
    stats.stop();
  });

  it("a null newestNormalizedEventAtUtc (redelivered frame) doesn't affect the lag figure", () => {
    const stats = createIngestStatsLogger("TD", 1000);
    stats.record(new Date(), null);
    vi.advanceTimersByTime(1000);
    expect(logSpy).toHaveBeenCalledWith(
      "TD ingest stats (last 1s): 1 frames, avg processing 0ms, max end-to-end lag 0s",
    );
    stats.stop();
  });
});
