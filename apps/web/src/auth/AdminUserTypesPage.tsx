import { Fragment, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { usePermissions } from "./permissions.js";

/** One permission from the API's registry (packages/database/src/permissions.ts). */
export interface PermissionInfo {
  key: string;
  category: string;
  label: string;
  description: string;
  codeGrantable: boolean;
}

export interface UserTypeInfo {
  id: string;
  systemKey: "public" | "admin" | null;
  name: string;
  description: string | null;
  sortOrder: number;
  grantsAll: boolean;
  permissions: string[];
  userCount: number;
  codeCount: number;
  codeGrantable: boolean;
}

export interface UserTypesResponse {
  types: UserTypeInfo[];
  permissions: PermissionInfo[];
  categories: { key: string; label: string }[];
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}

/**
 * Milestone 99 (docs/adr/0022): Admin › User types — the permission matrix. One column per user
 * type, one row per permission, grouped by category. Ticks are kept on the page until "Save
 * changes", which sends one PATCH per changed type. Admin always holds everything and can't be
 * changed; "No user (public)" is what anyone without a login or code gets. A permission the
 * signed-in user doesn't hold can't be ticked or unticked here (the API refuses it too).
 */
export function AdminUserTypesPage(): JSX.Element {
  const own = usePermissions();
  const [data, setData] = useState<UserTypesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Unsaved ticks: type id → its permissions as edited. */
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [renaming, setRenaming] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);

  async function load(): Promise<void> {
    try {
      const response = await fetch("/api/v1/admin/user-types");
      if (!response.ok) {
        setLoadError(
          await extractError(response, `Failed to load user types (${response.status})`),
        );
        return;
      }
      setData(await readApiJson<UserTypesResponse>(response));
      setLoadError(null);
    } catch {
      setLoadError("Failed to load user types.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loadError) {
    return (
      <p role="alert" className="app-error">
        {loadError}
      </p>
    );
  }
  if (!data) return <p className="app-loading">Loading user types…</p>;

  const permissionsOf = (type: UserTypeInfo): string[] => edits[type.id] ?? type.permissions;
  const changedTypes = data.types.filter(
    (type) => edits[type.id] && !sameSet(edits[type.id]!, type.permissions),
  );

  function toggle(type: UserTypeInfo, key: string): void {
    const current = permissionsOf(type);
    const next = current.includes(key) ? current.filter((p) => p !== key) : [...current, key];
    setEdits((prev) => ({ ...prev, [type.id]: next }));
    setNotice(null);
  }

  async function send(
    method: "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<boolean> {
    const response = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      setActionError(await extractError(response, `Request failed (${response.status})`));
      return false;
    }
    return true;
  }

  async function saveChanges(): Promise<void> {
    setSaving(true);
    setActionError(null);
    try {
      for (const type of changedTypes) {
        const ok = await send("PATCH", `/api/v1/admin/user-types/${type.id}`, {
          permissions: edits[type.id],
        });
        if (!ok) return;
      }
      setEdits({});
      setNotice("Saved. The changes apply on each person's next request.");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function createType(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setActionError(null);
    const source = data?.types.find((type) => type.id === copyFrom);
    const permissions = source
      ? (source.grantsAll ? data!.permissions.map((p) => p.key) : source.permissions).filter((p) =>
          own.has(p),
        )
      : [];
    const ok = await send("POST", "/api/v1/admin/user-types", {
      name: newName,
      description: newDescription.trim() || null,
      permissions,
    });
    if (ok) {
      setNewName("");
      setNewDescription("");
      setCopyFrom("");
      await load();
    }
  }

  async function saveRename(): Promise<void> {
    if (!renaming) return;
    setActionError(null);
    const ok = await send("PATCH", `/api/v1/admin/user-types/${renaming.id}`, {
      name: renaming.name,
      description: renaming.description.trim() || null,
    });
    if (ok) {
      setRenaming(null);
      await load();
    }
  }

  async function deleteType(type: UserTypeInfo): Promise<void> {
    if (!window.confirm(`Delete the user type "${type.name}"?`)) return;
    setActionError(null);
    if (await send("DELETE", `/api/v1/admin/user-types/${type.id}`)) await load();
  }

  const byCategory = data.categories.map((category) => ({
    ...category,
    permissions: data.permissions.filter((p) => p.category === category.key),
  }));

  return (
    <div className="admin-users-page user-types-page">
      <h2>User types</h2>
      <p className="field-hint">
        Each user has one type, and an access code can give one. Tick what each type may do.
        &ldquo;No user (public)&rdquo; is anyone without a login or a code: give it &ldquo;Use the
        site&rdquo; and &ldquo;Public maps&rdquo; to let the public in without a code. Admin always
        has everything, including permissions added later.
      </p>

      {actionError && (
        <p role="alert" className="login-form__error">
          {actionError}
        </p>
      )}
      {notice && <p className="map-inspector__note">{notice}</p>}

      <div className="table-scroll">
        <table className="users-table permission-matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {data.types.map((type) => (
                <th key={type.id} scope="col" className="permission-matrix__type">
                  <span>{type.name}</span>
                  <span className="permission-matrix__count">
                    {type.systemKey === "public"
                      ? "everyone"
                      : `${type.userCount} user${type.userCount === 1 ? "" : "s"}` +
                        (type.codeCount > 0
                          ? `, ${type.codeCount} code${type.codeCount === 1 ? "" : "s"}`
                          : "")}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byCategory.map((category) => (
              <Fragment key={category.key}>
                <tr className="permission-matrix__category">
                  <th scope="rowgroup" colSpan={data.types.length + 1}>
                    {category.label}
                  </th>
                </tr>
                {category.permissions.map((permission) => (
                  <tr key={permission.key}>
                    <th scope="row" className="permission-matrix__permission">
                      <span>{permission.label}</span>
                      <span className="field-hint">{permission.description}</span>
                    </th>
                    {data.types.map((type) => {
                      const checked =
                        type.grantsAll || permissionsOf(type).includes(permission.key);
                      const locked = type.grantsAll || !own.has(permission.key);
                      return (
                        <td key={type.id} className="permission-matrix__cell">
                          <input
                            type="checkbox"
                            aria-label={`${type.name}: ${permission.label}`}
                            checked={checked}
                            disabled={locked}
                            title={
                              type.grantsAll
                                ? "Admin always has every permission"
                                : !own.has(permission.key)
                                  ? "You can only give permissions you hold yourself"
                                  : undefined
                            }
                            onChange={() => toggle(type, permission.key)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="permission-matrix__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={changedTypes.length === 0 || saving}
          onClick={() => void saveChanges()}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={changedTypes.length === 0 || saving}
          onClick={() => setEdits({})}
        >
          Undo changes
        </button>
        {changedTypes.length > 0 && (
          <span className="field-hint">
            Unsaved: {changedTypes.map((type) => type.name).join(", ")}
          </span>
        )}
      </div>

      <h3>Types</h3>
      <ul className="group-list">
        {data.types.map((type) => (
          <li key={type.id} className="group-list__row">
            {renaming?.id === type.id ? (
              <>
                <input
                  aria-label="Name"
                  value={renaming.name}
                  disabled={type.systemKey === "public"}
                  onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                />
                <input
                  aria-label="Description"
                  value={renaming.description}
                  onChange={(e) => setRenaming({ ...renaming, description: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void saveRename()}
                >
                  Save
                </button>
                <button type="button" className="btn" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="group-list__name">{type.name}</span>
                <span className="field-hint">{type.description}</span>
                {type.systemKey !== "admin" && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setRenaming({
                        id: type.id,
                        name: type.name,
                        description: type.description ?? "",
                      })
                    }
                  >
                    Edit
                  </button>
                )}
                {type.systemKey === null && (
                  <button
                    type="button"
                    className="btn"
                    disabled={type.userCount > 0 || type.codeCount > 0}
                    title={
                      type.userCount > 0 || type.codeCount > 0
                        ? "Move its users and codes to another type first"
                        : undefined
                    }
                    onClick={() => void deleteType(type)}
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      <form className="panel-card users-form" onSubmit={(e) => void createType(e)}>
        <h3>New user type</h3>
        <label className="field">
          Name
          <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
        </label>
        <label className="field">
          Description
          <input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
        </label>
        <label className="field">
          Start from
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">No permissions</option>
            {data.types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn--primary">
          Add user type
        </button>
      </form>
    </div>
  );
}
