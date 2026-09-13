import { useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";

interface TdBoundary {
  id: string;
  areaA: string;
  berthA: string;
  areaB: string;
  berthB: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

/**
 * Milestone 39 (docs/adr/0007): admin-only management of `td_area_boundary` — the reference data
 * `run-lineage-daemon` uses to carry a matched run's identity across a TD-area crossing. Owner-
 * curated by design (never auto-derived or auto-applied from SMART) — this page is the only way
 * a boundary pair gets entered. Reference data entry, not visual map authoring, so it follows
 * `AdminUsersPage`'s pattern rather than the Konva canvas editor.
 */
export function TdBoundariesPage(): JSX.Element {
  const [boundaries, setBoundaries] = useState<TdBoundary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [areaA, setAreaA] = useState("");
  const [berthA, setBerthA] = useState("");
  const [areaB, setAreaB] = useState("");
  const [berthB, setBerthB] = useState("");
  const [notes, setNotes] = useState("");
  const [creating, setCreating] = useState(false);

  async function load(): Promise<void> {
    try {
      const response = await fetch("/api/v1/admin/td-boundaries");
      if (!response.ok) {
        setLoadError(
          await extractError(response, `Failed to load boundaries (${response.status})`),
        );
        return;
      }
      const body = await readApiJson<{ boundaries: TdBoundary[] }>(response);
      setBoundaries(body.boundaries);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load boundaries.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setCreating(true);
    setActionError(null);
    try {
      const response = await fetch("/api/v1/admin/td-boundaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          areaA: areaA.trim().toUpperCase(),
          berthA: berthA.trim(),
          areaB: areaB.trim().toUpperCase(),
          berthB: berthB.trim(),
          notes: notes.trim() || undefined,
        }),
      });
      if (!response.ok) {
        setActionError(await extractError(response, "Failed to add boundary."));
        return;
      }
      setAreaA("");
      setBerthA("");
      setAreaB("");
      setBerthB("");
      setNotes("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(boundary: TdBoundary): Promise<void> {
    if (
      !window.confirm(
        `Delete the boundary ${boundary.areaA} ${boundary.berthA} ↔ ${boundary.areaB} ${boundary.berthB}?`,
      )
    ) {
      return;
    }
    setActionError(null);
    const response = await fetch(`/api/v1/admin/td-boundaries/${encodeURIComponent(boundary.id)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) {
      setActionError(await extractError(response, "Failed to delete boundary."));
      return;
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
  if (!boundaries) {
    return <p className="app-loading">Loading TD boundaries…</p>;
  }

  return (
    <div className="admin-users-page">
      <h2>TD area boundaries</h2>
      <p className="field-hint">
        Owner-curated only (docs/adr/0007) — never auto-derived. Each row tells the run-lineage
        projector that this berth in area A and that berth in area B are the same physical crossing,
        so a confidently matched train's identity can be carried across it.
      </p>
      {actionError && (
        <p role="alert" className="login-form__error">
          {actionError}
        </p>
      )}

      <table className="users-table">
        <thead>
          <tr>
            <th>Area A</th>
            <th>Berth A</th>
            <th>Area B</th>
            <th>Berth B</th>
            <th>Notes</th>
            <th>Added by</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {boundaries.map((b) => (
            <tr key={b.id}>
              <td>{b.areaA}</td>
              <td>{b.berthA}</td>
              <td>{b.areaB}</td>
              <td>{b.berthB}</td>
              <td>{b.notes ?? ""}</td>
              <td>{b.createdBy}</td>
              <td>
                <button className="btn" onClick={() => void handleDelete(b)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="panel-card" onSubmit={(e) => void handleCreate(e)}>
        <h3>Add boundary</h3>
        <label className="field">
          Area A
          <input type="text" value={areaA} onChange={(e) => setAreaA(e.target.value)} required />
        </label>
        <label className="field">
          Berth A
          <input type="text" value={berthA} onChange={(e) => setBerthA(e.target.value)} required />
        </label>
        <label className="field">
          Area B
          <input type="text" value={areaB} onChange={(e) => setAreaB(e.target.value)} required />
        </label>
        <label className="field">
          Berth B
          <input type="text" value={berthB} onChange={(e) => setBerthB(e.target.value)} required />
        </label>
        <label className="field">
          Notes (optional)
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? "Adding…" : "Add boundary"}
        </button>
      </form>
    </div>
  );
}
