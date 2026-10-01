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
  /** Milestone 83: groups decide which restricted maps a user can see. */
  groupIds: string[];
}

interface Group {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

/** Milestone 83 adds groups: each user's group checkboxes, and a Groups section to add, rename and
 * delete them.
 *
 * Milestone 29: admin-only "Users" page — the day-to-day way to add/manage accounts once at
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
  const [newGroupIds, setNewGroupIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const [groups, setGroups] = useState<Group[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");

  async function load(): Promise<void> {
    try {
      const [response, groupsResponse] = await Promise.all([
        fetch("/api/v1/admin/users"),
        fetch("/api/v1/admin/groups"),
      ]);
      if (!response.ok) {
        setLoadError(await extractError(response, `Failed to load users (${response.status})`));
        return;
      }
      if (!groupsResponse.ok) {
        setLoadError(
          await extractError(groupsResponse, `Failed to load groups (${groupsResponse.status})`),
        );
        return;
      }
      const body = await readApiJson<{ users: AdminUser[] }>(response);
      setUsers(body.users);
      setGroups((await readApiJson<{ groups: Group[] }>(groupsResponse)).groups);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load users.");
    }
  }

  async function groupAction(
    url: string,
    method: string,
    body: unknown,
    fallback: string,
  ): Promise<boolean> {
    setActionError(null);
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    if (!response.ok && response.status !== 204) {
      setActionError(await extractError(response, fallback));
      return false;
    }
    await load();
    return true;
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
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          role: newRole,
          groupIds: newGroupIds,
        }),
      });
      if (!response.ok) {
        setActionError(await extractError(response, "Failed to create user."));
        return;
      }
      setNewUsername("");
      setNewPassword("");
      setNewRole("editor");
      setNewGroupIds([]);
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
            <th>Groups</th>
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
              <td>
                <div className="users-table__groups">
                  {groups.map((group) => (
                    <label key={group.id} className="field field--checkbox">
                      <input
                        type="checkbox"
                        checked={user.groupIds.includes(group.id)}
                        onChange={(e) =>
                          void patchUser(user.id, {
                            groupIds: e.target.checked
                              ? [...user.groupIds, group.id]
                              : user.groupIds.filter((id) => id !== group.id),
                          })
                        }
                      />
                      {group.name}
                    </label>
                  ))}
                  {groups.length === 0 && <span className="field-hint">none</span>}
                </div>
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
        {groups.length > 0 && (
          <fieldset className="users-form__groups">
            <legend>Groups</legend>
            {groups.map((group) => (
              <label key={group.id} className="field field--checkbox">
                <input
                  type="checkbox"
                  checked={newGroupIds.includes(group.id)}
                  onChange={(e) =>
                    setNewGroupIds((current) =>
                      e.target.checked
                        ? [...current, group.id]
                        : current.filter((id) => id !== group.id),
                    )
                  }
                />
                {group.name}
              </label>
            ))}
          </fieldset>
        )}
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? "Adding…" : "Add user"}
        </button>
      </form>

      <section className="panel-card">
        <h3>Groups</h3>
        <p className="field-hint">
          A group decides which restricted maps its members can see (Admin › Maps). Roles still
          decide what a user can do; admins see every map.
        </p>
        <ul className="group-list">
          {groups.map((group) => (
            <li key={group.id} className="group-list__row">
              {renamingGroupId === group.id ? (
                <form
                  className="group-list__rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void groupAction(
                      `/api/v1/admin/groups/${group.id}`,
                      "PATCH",
                      { name: groupName },
                      "Failed to rename group.",
                    ).then((ok) => ok && setRenamingGroupId(null));
                  }}
                >
                  <input
                    type="text"
                    aria-label="Group name"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    required
                  />
                  <button type="submit" className="btn btn--primary">
                    Save
                  </button>
                  <button type="button" className="btn" onClick={() => setRenamingGroupId(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="group-list__name">{group.name}</span>
                  <span className="group-list__count">
                    {group.memberCount} {group.memberCount === 1 ? "member" : "members"}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setRenamingGroupId(group.id);
                      setGroupName(group.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the group "${group.name}"? Maps shared only with it become admins-only.`,
                        )
                      ) {
                        void groupAction(
                          `/api/v1/admin/groups/${group.id}`,
                          "DELETE",
                          undefined,
                          "Failed to delete group.",
                        );
                      }
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          className="group-list__add"
          onSubmit={(e) => {
            e.preventDefault();
            void groupAction(
              "/api/v1/admin/groups",
              "POST",
              { name: newGroupName },
              "Failed to add group.",
            ).then((ok) => ok && setNewGroupName(""));
          }}
        >
          <label className="field">
            New group
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="btn btn--primary">
            Add group
          </button>
        </form>
      </section>
    </div>
  );
}
