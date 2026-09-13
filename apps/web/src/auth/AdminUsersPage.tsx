import { useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import type { UserRole } from "./useSession.js";

interface AdminUser {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

/** Milestone 29: admin-only "Users" page — the day-to-day way to add/manage accounts once at
 * least one admin exists (the very first admin has to come from the worker's `manage-users` CLI,
 * since nothing is logged in yet to use this page). Only rendered by `App.tsx` when the current
 * session's role is "admin"; the API independently enforces the same gate. */
export function AdminUsersPage(): JSX.Element {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("editor");
  const [creating, setCreating] = useState(false);

  async function load(): Promise<void> {
    try {
      const response = await fetch("/api/v1/admin/users");
      if (!response.ok) {
        setLoadError(await extractError(response, `Failed to load users (${response.status})`));
        return;
      }
      const body = await readApiJson<{ users: AdminUser[] }>(response);
      setUsers(body.users);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load users.");
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
      const response = await fetch("/api/v1/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      });
      if (!response.ok) {
        setActionError(await extractError(response, "Failed to create user."));
        return;
      }
      setNewUsername("");
      setNewPassword("");
      setNewRole("editor");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function patchUser(id: string, body: Record<string, unknown>): Promise<void> {
    setActionError(null);
    const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setActionError(await extractError(response, "Failed to update user."));
      return;
    }
    await load();
  }

  async function handleDelete(user: AdminUser): Promise<void> {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setActionError(null);
    const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) {
      setActionError(await extractError(response, "Failed to delete user."));
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
  if (!users) {
    return <p className="app-loading">Loading users…</p>;
  }

  return (
    <div className="admin-users-page">
      <h2>Users</h2>
      {actionError && (
        <p role="alert" className="login-form__error">
          {actionError}
        </p>
      )}

      <table className="users-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Last login</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.username}</td>
              <td>
                <select
                  value={user.role}
                  onChange={(e) => void patchUser(user.id, { role: e.target.value })}
                >
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td>
                <label className="field field--checkbox">
                  <input
                    type="checkbox"
                    checked={user.isActive}
                    onChange={(e) => void patchUser(user.id, { isActive: e.target.checked })}
                  />
                  active
                </label>
              </td>
              <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "never"}</td>
              <td>
                <button className="btn" onClick={() => void handleDelete(user)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="panel-card" onSubmit={(e) => void handleCreate(e)}>
        <h3>Add user</h3>
        <label className="field">
          Username
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        <label className="field">
          Role
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? "Adding…" : "Add user"}
        </button>
      </form>
    </div>
  );
}
