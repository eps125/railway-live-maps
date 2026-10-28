import { useCallback, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";

/** Milestone 99 (docs/adr/0022): a user's type and every permission they hold. */
export interface SessionUser {
  username: string;
  userType: { id: string; name: string | null };
  permissions: string[];
}

export type SessionState =
  | { status: "loading" }
  | { status: "authenticated"; user: SessionUser }
  | { status: "unauthenticated" };

export interface UseSessionResult {
  session: SessionState;
  /** Re-checks `/api/v1/auth/me` — call after a successful login. */
  refresh: () => Promise<void>;
  /** Calls `/api/v1/auth/logout` then refreshes local state. */
  logout: () => Promise<void>;
}

/** Milestone 29: the frontend's single source of truth for "who is logged in" — and, since
 * Milestone 99, what they may do (`permissions`), which gates the Admin link and the editor and
 * admin routes in `App.tsx`. A 401
 * from `/api/v1/auth/me` is the normal "not logged in" case, not an error. */
export function useSession(): UseSessionResult {
  const [session, setSession] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/auth/me");
      if (response.status === 401) {
        setSession({ status: "unauthenticated" });
        return;
      }
      if (!response.ok) {
        setSession({ status: "unauthenticated" });
        return;
      }
      const user = await readApiJson<SessionUser>(response);
      setSession({ status: "authenticated", user });
    } catch {
      setSession({ status: "unauthenticated" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    setSession({ status: "unauthenticated" });
  }, []);

  return { session, refresh, logout };
}
