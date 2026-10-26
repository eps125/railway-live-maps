import { useCallback, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { formatLondon, fromDateTimeLocal, toDateTimeLocal } from "./accessCodeFormat.js";

type JobKind = "berth_allowances" | "link_backfill";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface AreaStatus {
  tdArea: string;
  allowanceBerths: number;
  measuredBerths: number;
  allowancesCalculatedAt: string | null;
}

export interface MaintenanceJobView {
  id: string;
  kind: JobKind;
  tdAreas: string[];
  params: Record<string, unknown>;
  status: JobStatus;
  cancelRequested: boolean;
  attempts: number;
  progress: { done?: number; total?: number; current?: string | null };
  result: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface ErrorBody {
  error?: { message?: string };
}

const KIND_LABEL: Record<JobKind, string> = {
  berth_allowances: "Recalculate berth allowances",
  link_backfill: "Backfill run links",
};

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const POLL_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One line saying what a finished (or stopped) job did. Exported for tests. */
export function jobSummary(job: MaintenanceJobView): string {
  if (job.status === "failed") return job.error ?? "Failed";
  const result = job.result;
  if (!result) {
    const { done, total } = job.progress;
    if (job.status === "running" && typeof done === "number" && typeof total === "number") {
      return `${done} of ${total}${job.cancelRequested ? " — stopping" : ""}`;
    }
    return "";
  }
  if (job.kind === "berth_allowances") {
    const areas = (result.areas ?? {}) as Record<string, { berths: number; measured: number }>;
    const berths = Object.values(areas).reduce((sum, a) => sum + a.berths, 0);
    const measured = Object.values(areas).reduce((sum, a) => sum + a.measured, 0);
    return `${berths} berths (${measured} measured, ${berths - measured} default) over ${String(
      result.windowDays,
    )} days`;
  }
  return `${String(result.linked ?? 0)} linked, ${String(result.carriedForward ?? 0)} carried on, ${String(
    result.examined ?? 0,
  )} examined`;
}

/**
 * Milestone 97a (docs/adr/0021): admin "Area maintenance". Queues jobs the worker runs one at a
 * time: recalculating each berth's allowance (the normal time a train spends in it, used by the
 * held-train delay estimate), and backfilling run links for an area's past occupancies (what a
 * newly mapped area needs before its history shows delay colours). Polls while a job is active.
 */
export function AdminMaintenancePage(): JSX.Element {
  const [areas, setAreas] = useState<AreaStatus[] | null>(null);
  const [jobs, setJobs] = useState<MaintenanceJobView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<JobKind>("berth_allowances");
  const [windowDays, setWindowDays] = useState(14);
  const [from, setFrom] = useState(() =>
    toDateTimeLocal(new Date(Date.now() - 7 * DAY_MS).toISOString()),
  );
  const [to, setTo] = useState(() => toDateTimeLocal(new Date().toISOString()));
  const [correct, setCorrect] = useState(false);
  const [queueing, setQueueing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [areasResponse, jobsResponse] = await Promise.all([
        fetch("/api/v1/admin/maintenance/areas"),
        fetch("/api/v1/admin/maintenance/jobs"),
      ]);
      if (!areasResponse.ok || !jobsResponse.ok) {
        setLoadError(`Failed to load maintenance (${areasResponse.status}/${jobsResponse.status})`);
        return;
      }
      setAreas((await readApiJson<{ areas: AreaStatus[] }>(areasResponse)).areas);
      setJobs((await readApiJson<{ jobs: MaintenanceJobView[] }>(jobsResponse)).jobs);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load maintenance.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  function toggle(area: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });
  }

  async function handleQueue(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setActionError(null);
    if (selected.size === 0) {
      setActionError("Choose at least one TD area.");
      return;
    }
    const params =
      kind === "berth_allowances"
        ? { windowDays }
        : { from: fromDateTimeLocal(from), to: fromDateTimeLocal(to), correct };
    setQueueing(true);
    try {
      const response = await fetch("/api/v1/admin/maintenance/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, tdAreas: [...selected].sort(), params }),
      });
      if (!response.ok) {
        const body = await readApiJson<ErrorBody>(response);
        setActionError(body.error?.message ?? `Failed to queue the job (${response.status})`);
        return;
      }
      await load();
    } finally {
      setQueueing(false);
    }
  }

  async function handleCancel(job: MaintenanceJobView): Promise<void> {
    setActionError(null);
    const response = await fetch(`/api/v1/admin/maintenance/jobs/${job.id}/cancel`, {
      method: "POST",
    });
    if (!response.ok) {
      const body = await readApiJson<ErrorBody>(response);
      setActionError(body.error?.message ?? `Failed to cancel (${response.status})`);
    }
    await load();
  }

  if (loadError) {
    return (
      <p role="alert" className="app-error">
        {loadError}
      </p>
    );
  }
  if (!areas) {
    return <p className="app-loading">Loading area maintenance…</p>;
  }

  return (
    <div className="admin-users-page">
      <h2>Area maintenance</h2>
      <p className="field-hint">
        Jobs run in the background, one at a time. Berth allowances are the normal time a train
        spends in each berth (unusual stands removed), used when estimating the delay of a held
        train. A newly mapped area needs its run links backfilled before its history shows delay
        colours.
      </p>
      {actionError && (
        <p role="alert" className="login-form__error">
          {actionError}
        </p>
      )}

      <table className="users-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all areas"
                checked={areas.length > 0 && selected.size === areas.length}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(areas.map((a) => a.tdArea)) : new Set())
                }
              />
            </th>
            <th>TD area</th>
            <th>Berths with an allowance</th>
            <th>Measured</th>
            <th>Allowances calculated</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => (
            <tr key={area.tdArea}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${area.tdArea}`}
                  checked={selected.has(area.tdArea)}
                  onChange={() => toggle(area.tdArea)}
                />
              </td>
              <td>{area.tdArea}</td>
              <td>{area.allowanceBerths}</td>
              <td>{area.measuredBerths}</td>
              <td>
                {area.allowancesCalculatedAt ? formatLondon(area.allowancesCalculatedAt) : "Never"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="panel-card" onSubmit={(e) => void handleQueue(e)}>
        <h3>Queue a job for the selected areas</h3>
        <label className="field">
          Job
          <select value={kind} onChange={(e) => setKind(e.target.value as JobKind)}>
            <option value="berth_allowances">{KIND_LABEL.berth_allowances}</option>
            <option value="link_backfill">{KIND_LABEL.link_backfill}</option>
          </select>
        </label>
        {kind === "berth_allowances" ? (
          <label className="field">
            Days of history to measure
            <input
              type="number"
              min={1}
              max={60}
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
            />
          </label>
        ) : (
          <>
            <label className="field">
              From
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              To
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="field field--checkbox">
              <input
                type="checkbox"
                checked={correct}
                onChange={(e) => setCorrect(e.target.checked)}
              />
              Also correct links that now match a different run (only when TRUST confirms it)
            </label>
          </>
        )}
        <button type="submit" className="btn btn--primary" disabled={queueing}>
          {queueing ? "Queueing…" : "Queue job"}
        </button>
      </form>

      <h3>Recent jobs</h3>
      {jobs.length === 0 ? (
        <p className="field-hint">No jobs yet.</p>
      ) : (
        <table className="users-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Areas</th>
              <th>Status</th>
              <th>Result</th>
              <th>Requested</th>
              <th>Finished</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{KIND_LABEL[job.kind]}</td>
                <td>{job.tdAreas.join(", ")}</td>
                <td>{STATUS_LABEL[job.status]}</td>
                <td>{jobSummary(job)}</td>
                <td>
                  {formatLondon(job.requestedAt)} by {job.requestedBy}
                </td>
                <td>{job.finishedAt ? formatLondon(job.finishedAt) : ""}</td>
                <td>
                  {(job.status === "queued" || job.status === "running") &&
                    !job.cancelRequested && (
                      <button className="btn" onClick={() => void handleCancel(job)}>
                        Cancel
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
