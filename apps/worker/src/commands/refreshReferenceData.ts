import type { Config } from "../config.js";
import { runDownloadSmart } from "./downloadSmart.js";
import { runDownloadCorpus } from "./downloadCorpus.js";

interface StepResult {
  step: "smart" | "corpus";
  ok: boolean;
  error?: string;
}

/**
 * `refresh-reference-data` — runs download-smart and download-corpus back to back. Each step runs
 * regardless of the other's outcome (a bad CORPUS fetch must not block a good SMART refresh);
 * failures are collected and thrown together at the end so a manual console run still exits
 * non-zero. `schedule-reference-refresh`'s daily loop catches around the whole call instead, so
 * one bad night logs rather than crash-loops the container.
 *
 * The CIF SCHEDULE step was removed with RLM's own schedule model (ADR 0002, 2026-09-01) —
 * schedule data is now mirrored from the operator's openrail-eps instance by `ingest-garner`.
 */
export async function runRefreshReferenceData(config: Config): Promise<void> {
  const steps: Array<{ step: StepResult["step"]; run: () => Promise<void> }> = [
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
