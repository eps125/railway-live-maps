import { useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { compareMapNames } from "../mapList.js";
import {
  ACCESS_PERIOD_PRESETS,
  FLAG_TEXT,
  formatDuration,
  formatLondon,
  fromDateTimeLocal,
  toDateTimeLocal,
} from "./accessCodeFormat.js";

type Scope = "site" | "maps";

interface AccessCode {
  id: string;
  label: string;
  code: string;
  scope: Scope;
  mapIds: string[];
  maxUses: number | null;
  useCount: number;
  accessSeconds: number;
  validUntil: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  activeGrants: number;
  lastUsedAt: string | null;
  status: "active" | "revoked" | "expired" | "used_up";
}

interface Grant {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  firstIp: string | null;
  firstUserAgent: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  distinctIps: number;
  requestCount: number;
  flags: string[];
  activity: { hour: string; ip: string; userAgent: string | null; requestCount: number }[];
}

interface CodeDetail extends AccessCode {
  flags: string[];
  grants: Grant[];
}

interface MapOption {
  id: string;
  slug: string;
  name: string;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

async function sendJson(url: string, method: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

const STATUS_TEXT: Record<AccessCode["status"], string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  used_up: "Used up",
};

function scopeText(code: Pick<AccessCode, "scope" | "mapIds">, maps: MapOption[]): string {
  if (code.scope === "site") return "Whole site (public maps)";
  const names = code.mapIds
    .map((id) => maps.find((map) => map.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return `Only: ${names.join(", ") || "no maps"}`;
}

function grantState(grant: Grant): "active" | "expired" | "revoked" {
  if (grant.revokedAt) return "revoked";
  return new Date(grant.expiresAt).getTime() > Date.now() ? "active" : "expired";
}

/**
 * Milestone 84 (docs/adr/0018 §6): Admin › Access codes — switch the site between open and
 * code-required, create codes (generated or custom; whole site or chosen maps; use limit; how long
 * each use lasts; optional last-entry date), view each code's uses and activity with flags that may
 * mean sharing, change or end a single use, and revoke codes.
 */
export function AdminAccessPage(): JSX.Element {
  const [mode, setMode] = useState<"open" | "code_required" | null>(null);
  const [codes, setCodes] = useState<AccessCode[] | null>(null);
  const [maps, setMaps] = useState<MapOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openCodeId, setOpenCodeId] = useState<string | null>(null);
  const [editingCodeId, setEditingCodeId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Owner request 2026-10-01: delete or purge a code for good (asks first). Delete keeps the
  // audit trail; purge removes it too.
  const [removing, setRemoving] = useState<{ id: string; mode: "delete" | "purge" } | null>(null);

  async function load(): Promise<void> {
    try {
      const [settingsRes, codesRes, mapsRes] = await Promise.all([
        fetch("/api/v1/admin/settings"),
        fetch("/api/v1/admin/access-codes"),
        fetch("/api/v1/editor/maps"),
      ]);
      for (const response of [settingsRes, codesRes, mapsRes]) {
        if (!response.ok) {
          setLoadError(await extractError(response, `Failed to load (${response.status})`));
          return;
        }
      }
      setMode(
        (
          await readApiJson<{ settings: { site_access_mode: "open" | "code_required" } }>(
            settingsRes,
          )
        ).settings.site_access_mode,
      );
      setCodes((await readApiJson<{ codes: AccessCode[] }>(codesRes)).codes);
      setMaps((await readApiJson<{ maps: MapOption[] }>(mapsRes)).maps.sort(compareMapNames));
      setLoadError(null);
    } catch {
      setLoadError("Failed to load access codes.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(response: Promise<Response>, fallback: string): Promise<boolean> {
    setActionError(null);
    const result = await response;
    if (!result.ok) {
      setActionError(await extractError(result, fallback));
      return false;
    }
    await load();
    return true;
  }

  async function changeMode(next: "open" | "code_required"): Promise<void> {
    const question =
      next === "code_required"
        ? "Require an access code? Guests without a code will be asked for one, and anyone " +
          "watching a map without one is disconnected within a minute. Signed-in users are not affected."
        : "Open the site to everyone again? Access codes stay valid but are no longer needed.";
    if (!window.confirm(question)) return;
    await act(
      sendJson("/api/v1/admin/settings", "PATCH", { site_access_mode: next }),
      "Failed to change the site access mode.",
    );
  }

  if (loadError) {
    return (
      <p role="alert" className="app-error">
        {loadError}
      </p>
    );
  }
  if (!codes || !mode) return <p className="app-loading">Loading access codes…</p>;

  return (
    <div className="admin-users-page admin-access-page">
      <h2>Access codes</h2>
      {actionError && (
        <p role="alert" className="login-form__error">
          {actionError}
        </p>
      )}

      <section className="panel-card">
        <h3>Site access</h3>
        <fieldset className="admin-access-page__mode">
          <legend className="visually-hidden">Site access mode</legend>
          <label className="field field--checkbox">
            <input
              type="radio"
              name="site-access-mode"
              checked={mode === "open"}
              onChange={() => void changeMode("open")}
            />
            Open to everyone
          </label>
          <label className="field field--checkbox">
            <input
              type="radio"
              name="site-access-mode"
              checked={mode === "code_required"}
              onChange={() => void changeMode("code_required")}
            />
            Access code required (guests see the code page first)
          </label>
        </fieldset>
        <p className="field-hint">
          Signed-in users never need a code. A code that names maps also shows those maps when the
          site is open, even if they are not public.
        </p>
      </section>

      {creating ? (
        <CodeForm
          maps={maps}
          onCancel={() => setCreating(false)}
          onSubmit={async (body) => {
            if (
              await act(
                sendJson("/api/v1/admin/access-codes", "POST", body),
                "Failed to create code.",
              )
            ) {
              setCreating(false);
            }
          }}
        />
      ) : (
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          New access code
        </button>
      )}

      {codes.length === 0 ? (
        <p className="panel-card panel-card--empty">No access codes yet.</p>
      ) : (
        <ul className="access-code-list">
          {codes.map((code) => (
            <li key={code.id} className={`access-code access-code--${code.status}`}>
              <div className="access-code__head">
                <div className="access-code__title">
                  <strong>{code.label}</strong>
                  <code className="access-code__code">{code.code}</code>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Copy code ${code.code}`}
                    onClick={() => void navigator.clipboard?.writeText(code.code)}
                  >
                    Copy
                  </button>
                </div>
                <span className={`access-code__status access-code__status--${code.status}`}>
                  {STATUS_TEXT[code.status]}
                </span>
              </div>
              <dl className="admin-map-row__facts">
                <div>
                  <dt>Gives</dt>
                  <dd>{scopeText(code, maps)}</dd>
                </div>
                <div>
                  <dt>Uses</dt>
                  <dd>
                    {code.useCount} of {code.maxUses ?? "unlimited"}
                  </dd>
                </div>
                <div>
                  <dt>Each use lasts</dt>
                  <dd>{formatDuration(code.accessSeconds)}</dd>
                </div>
                <div>
                  <dt>Can be entered until</dt>
                  <dd>{code.validUntil ? formatLondon(code.validUntil) : "No end date"}</dd>
                </div>
                <div>
                  <dt>In use now</dt>
                  <dd>{code.activeGrants}</dd>
                </div>
                <div>
                  <dt>Last entered</dt>
                  <dd>{formatLondon(code.lastUsedAt)}</dd>
                </div>
              </dl>
              {code.notes && <p className="field-hint">{code.notes}</p>}
              <div className="admin-map-row__actions">
                <button
                  type="button"
                  className="btn"
                  aria-expanded={openCodeId === code.id}
                  onClick={() => setOpenCodeId(openCodeId === code.id ? null : code.id)}
                >
                  Uses and activity
                </button>
                {code.status !== "revoked" ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      aria-expanded={editingCodeId === code.id}
                      onClick={() => setEditingCodeId(editingCodeId === code.id ? null : code.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Revoke "${code.label}"? It can't be entered again, and everyone using it loses access within a minute. You can re-enable it later.`,
                          )
                        ) {
                          void act(
                            sendJson(`/api/v1/admin/access-codes/${code.id}/revoke`, "POST"),
                            "Failed to revoke code.",
                          );
                        }
                      }}
                    >
                      Revoke
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void act(
                        sendJson(`/api/v1/admin/access-codes/${code.id}/restore`, "POST"),
                        "Failed to re-enable code.",
                      )
                    }
                  >
                    Re-enable
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  aria-expanded={removing?.id === code.id && removing.mode === "delete"}
                  onClick={() => setRemoving({ id: code.id, mode: "delete" })}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-expanded={removing?.id === code.id && removing.mode === "purge"}
                  onClick={() => setRemoving({ id: code.id, mode: "purge" })}
                >
                  Purge
                </button>
              </div>
              {removing?.id === code.id ? (
                <div
                  className="access-code__delete"
                  role="group"
                  aria-label={removing.mode === "purge" ? "Purge this code" : "Delete this code"}
                >
                  <p>
                    {removing.mode === "purge" ? "Purge" : "Delete"} <strong>{code.label}</strong>{" "}
                    for good? Its uses and their activity go with it, and anyone using it loses
                    access within a minute. This can&apos;t be undone.{" "}
                    {removing.mode === "purge"
                      ? "Every audit log entry about it goes too, and the purge isn't recorded."
                      : "The audit log keeps a note that it was deleted."}
                  </p>
                  <div className="admin-map-row__actions">
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() =>
                        void act(
                          removing.mode === "purge"
                            ? sendJson(`/api/v1/admin/access-codes/${code.id}/purge`, "POST")
                            : sendJson(`/api/v1/admin/access-codes/${code.id}`, "DELETE"),
                          removing.mode === "purge"
                            ? "Failed to purge code."
                            : "Failed to delete code.",
                        ).then((ok) => ok && setRemoving(null))
                      }
                    >
                      {removing.mode === "purge" ? "Purge for good" : "Delete for good"}
                    </button>
                    <button type="button" className="btn" onClick={() => setRemoving(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {editingCodeId === code.id && (
                <CodeForm
                  maps={maps}
                  existing={code}
                  onCancel={() => setEditingCodeId(null)}
                  onSubmit={async (body) => {
                    if (
                      await act(
                        sendJson(`/api/v1/admin/access-codes/${code.id}`, "PATCH", body),
                        "Failed to save code.",
                      )
                    ) {
                      setEditingCodeId(null);
                    }
                  }}
                />
              )}
              {openCodeId === code.id && (
                <CodeUses codeId={code.id} onChanged={() => void load()} onError={setActionError} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CodeFormBody {
  label: string;
  code?: string;
  scope: Scope;
  mapIds: string[];
  maxUses: number | null;
  accessSeconds: number;
  validUntil: string | null;
  notes: string | null;
}

/** Create (no `existing`) or edit a code. A code's text can only be chosen when creating it. */
function CodeForm({
  maps,
  existing,
  onSubmit,
  onCancel,
}: {
  maps: MapOption[];
  existing?: AccessCode;
  onSubmit: (body: CodeFormBody | Omit<CodeFormBody, "code">) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [customCode, setCustomCode] = useState(false);
  const [code, setCode] = useState("");
  const [scope, setScope] = useState<Scope>(existing?.scope ?? "site");
  const [mapIds, setMapIds] = useState<string[]>(existing?.mapIds ?? []);
  const [limited, setLimited] = useState(existing ? existing.maxUses !== null : false);
  const [maxUses, setMaxUses] = useState(String(existing?.maxUses ?? 1));
  const initialSeconds = existing?.accessSeconds ?? 24 * 60 * 60;
  const isPreset = ACCESS_PERIOD_PRESETS.some((p) => p.seconds === initialSeconds);
  const [period, setPeriod] = useState(isPreset ? String(initialSeconds) : "custom");
  const [customHours, setCustomHours] = useState(String(Math.round(initialSeconds / 3600)));
  const [validUntil, setValidUntil] = useState(
    existing?.validUntil ? toDateTimeLocal(existing.validUntil) : "",
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);

  const accessSeconds =
    period === "custom" ? Math.round(Number(customHours) * 3600) : Number(period);

  return (
    <form
      className="panel-card access-code-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        const body: CodeFormBody = {
          label,
          scope,
          mapIds: scope === "maps" ? mapIds : [],
          maxUses: limited ? Number(maxUses) : null,
          accessSeconds,
          validUntil: fromDateTimeLocal(validUntil),
          notes: notes.trim() ? notes.trim() : null,
        };
        if (!existing && customCode && code.trim()) body.code = code.trim();
        void onSubmit(body).finally(() => setSaving(false));
      }}
    >
      <h3>{existing ? `Edit “${existing.label}”` : "New access code"}</h3>
      <label className="field">
        Label (who or what it is for)
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          required
        />
      </label>

      {!existing && (
        <fieldset className="access-code-form__group">
          <legend>Code</legend>
          <label className="field field--checkbox">
            <input type="radio" checked={!customCode} onChange={() => setCustomCode(false)} />
            Generate one (like K7QM-3XRP)
          </label>
          <label className="field field--checkbox">
            <input type="radio" checked={customCode} onChange={() => setCustomCode(true)} />
            Choose my own
          </label>
          {customCode && (
            <label className="field">
              Your code (4–32 letters or digits)
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                pattern="[A-Za-z0-9 \-]{4,40}"
                required
              />
            </label>
          )}
        </fieldset>
      )}

      <fieldset className="access-code-form__group">
        <legend>Gives access to</legend>
        <label className="field field--checkbox">
          <input type="radio" checked={scope === "site"} onChange={() => setScope("site")} />
          The whole site (public maps)
        </label>
        <label className="field field--checkbox">
          <input type="radio" checked={scope === "maps"} onChange={() => setScope("maps")} />
          Only these maps (even if they are not public)
        </label>
        {scope === "maps" && (
          <div className="admin-map-settings__groups">
            {maps.map((map) => (
              <label key={map.id} className="field field--checkbox">
                <input
                  type="checkbox"
                  checked={mapIds.includes(map.id)}
                  onChange={(e) =>
                    setMapIds((current) =>
                      e.target.checked
                        ? [...current, map.id]
                        : current.filter((id) => id !== map.id),
                    )
                  }
                />
                {map.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="access-code-form__group">
        <legend>Number of uses</legend>
        <label className="field field--checkbox">
          <input type="radio" checked={!limited} onChange={() => setLimited(false)} />
          Unlimited
        </label>
        <label className="field field--checkbox">
          <input type="radio" checked={limited} onChange={() => setLimited(true)} />
          Limited to
          <input
            type="number"
            className="access-code-form__number"
            aria-label="Maximum uses"
            min={existing?.useCount || 1}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            disabled={!limited}
          />
          uses
        </label>
      </fieldset>

      <label className="field">
        Each use gives access for
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {ACCESS_PERIOD_PRESETS.map((preset) => (
            <option key={preset.seconds} value={String(preset.seconds)}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {period === "custom" && (
        <label className="field">
          Hours
          <input
            type="number"
            min={1}
            max={8784}
            value={customHours}
            onChange={(e) => setCustomHours(e.target.value)}
            required
          />
        </label>
      )}
      {existing && (
        <p className="field-hint">
          A new length applies to future uses; change a current use below.
        </p>
      )}

      <label className="field">
        Can be entered until (optional)
        <input
          type="datetime-local"
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
        />
      </label>

      <label className="field">
        Notes (optional)
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
        />
      </label>

      <div className="admin-map-settings__buttons">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save" : "Create code"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Every use of one code, newest first, with its activity and controls to change or end it. */
function CodeUses({
  codeId,
  onChanged,
  onError,
}: {
  codeId: string;
  onChanged: () => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<CodeDetail | null>(null);
  const [openGrantId, setOpenGrantId] = useState<string | null>(null);
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");

  async function load(): Promise<void> {
    const response = await fetch(`/api/v1/admin/access-codes/${codeId}`);
    if (!response.ok) {
      onError(await extractError(response, "Failed to load the code's uses."));
      return;
    }
    setDetail(await readApiJson<CodeDetail>(response));
  }

  useEffect(() => {
    void load();
  }, [codeId]);

  async function grantAction(url: string, method: string, body?: unknown): Promise<void> {
    onError(null);
    const response = await sendJson(url, method, body);
    if (!response.ok) {
      onError(await extractError(response, "Failed to change that use."));
      return;
    }
    setEditingGrantId(null);
    await load();
    onChanged();
  }

  if (!detail) return <p className="app-loading">Loading uses…</p>;

  return (
    <div className="access-code__uses">
      {detail.flags.map((flag) => (
        <p key={flag} className="access-code__flag" role="note">
          ⚠ {FLAG_TEXT[flag] ?? flag}
        </p>
      ))}
      {detail.grants.length === 0 ? (
        <p className="field-hint">Not used yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="users-table">
            <thead>
              <tr>
                <th>Entered (UK)</th>
                <th>Access until</th>
                <th>State</th>
                <th>From</th>
                <th>Last seen</th>
                <th>Addresses</th>
                <th>Requests</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {detail.grants.map((grant) => {
                const state = grantState(grant);
                return (
                  <tr key={grant.id}>
                    <td>{formatLondon(grant.createdAt)}</td>
                    <td>
                      {editingGrantId === grant.id ? (
                        <form
                          className="access-code__expiry-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const iso = fromDateTimeLocal(expiry);
                            if (iso) {
                              void grantAction(`/api/v1/admin/access-grants/${grant.id}`, "PATCH", {
                                expiresAt: iso,
                              });
                            }
                          }}
                        >
                          <input
                            type="datetime-local"
                            aria-label="Access until"
                            value={expiry}
                            onChange={(e) => setExpiry(e.target.value)}
                            required
                          />
                          <button type="submit" className="btn btn--primary">
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setEditingGrantId(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        formatLondon(grant.expiresAt)
                      )}
                    </td>
                    <td>
                      {state === "active" ? "Active" : state === "revoked" ? "Revoked" : "Ended"}
                    </td>
                    <td title={grant.firstUserAgent ?? undefined}>{grant.firstIp ?? "—"}</td>
                    <td>
                      {formatLondon(grant.lastSeenAt)}
                      {grant.lastIp && grant.lastIp !== grant.firstIp && (
                        <span className="field-hint"> from {grant.lastIp}</span>
                      )}
                    </td>
                    <td>
                      {grant.distinctIps}
                      {grant.flags.length > 0 && (
                        <span
                          className="access-code__flag-mark"
                          title={grant.flags.map((flag) => FLAG_TEXT[flag] ?? flag).join("; ")}
                        >
                          {" "}
                          ⚠
                        </span>
                      )}
                    </td>
                    <td>{grant.requestCount}</td>
                    <td className="access-code__grant-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setOpenGrantId(openGrantId === grant.id ? null : grant.id)}
                      >
                        Activity
                      </button>
                      {state !== "revoked" && (
                        <>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              setEditingGrantId(grant.id);
                              setExpiry(toDateTimeLocal(grant.expiresAt));
                            }}
                          >
                            Change end
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              if (window.confirm("End this use now?")) {
                                void grantAction(
                                  `/api/v1/admin/access-grants/${grant.id}/revoke`,
                                  "POST",
                                );
                              }
                            }}
                          >
                            End now
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {openGrantId &&
        (() => {
          const grant = detail.grants.find((g) => g.id === openGrantId);
          if (!grant) return null;
          return (
            <div className="access-code__activity">
              <h4>Activity for the use entered {formatLondon(grant.createdAt)}</h4>
              {grant.activity.length === 0 ? (
                <p className="field-hint">No requests recorded yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="users-table">
                    <thead>
                      <tr>
                        <th>Hour (UK)</th>
                        <th>Address</th>
                        <th>Requests</th>
                        <th>Browser</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grant.activity.map((row) => (
                        <tr key={`${row.hour}|${row.ip}`}>
                          <td>{formatLondon(row.hour)}</td>
                          <td>{row.ip}</td>
                          <td>{row.requestCount}</td>
                          <td className="access-code__agent">{row.userAgent ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
