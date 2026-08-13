import type { Config } from "../config.js";
import { runDownloadSchedule } from "./downloadSchedule.js";
import { runDownloadSmart } from "./downloadSmart.js";
import { runDownloadCorpus } from "./downloadCorpus.js";

interface StepResult {
  step: "schedule" | "smart" | "corpus";
  ok: boolean;
  error?: string;
}

/**
 * `refresh-reference-data` — runs download-schedule, download-smart and download-corpus back to
 * back. Each step runs regardless of the others' outcome (a bad CORPUS fetch must not block a
 * good SCHEDULE refresh, or vice versa); failures are collected and thrown together at the end so
 * a manual console run still exits non-zero. `schedule-reference-refresh`'s daily loop catches
 * around the whole call instead, so one bad night logs rather than crash-loops the container.
 */
export async function runRefreshReferenceData(config: Config): Promise<void> {
  const steps: Array<{ step: StepResult["step"]; run: () => Promise<void> }> = [
    { step: "schedule", run: () => runDownloadSchedule(config) },
    { step: "smart", run: () => runDownloadSmart(config) },
    { step: "corpus", run: () => runDownloadCorpus(config) },
  ];

  const results: StepResult[] = [];
  for (const { step, run } of steps) {
    try {
      await run();
      results.push({ step, ok: true });
    } catch (error) {
      console.error(`refresh-reference-data: ${step} failed:`, error);
      results.push({
        step,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("refresh-reference-data results:", results);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(
      `refresh-reference-data: ${failed.length}/${results.length} step(s) failed: ` +
        failed.map((f) => `${f.step} (${f.error})`).join("; "),
    );
  }
}
