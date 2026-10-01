import { useCallback, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";

export interface AccessStatus {
  mode: "open" | "code_required";
  access: "user" | "code" | "none";
  /** False only when the site needs a code and this visitor has neither a login nor a code. */
  allowed: boolean;
  expiresAt: string | null;
  scope: "site" | "maps" | null;
  maps: { slug: string; name: string }[];
}

export type AccessState = { status: "loading" } | { status: "ready"; access: AccessStatus };

/** How often the page re-checks, so an expired or revoked code returns the visitor to the code
 * page without them reloading. */
const RECHECK_MS = 60_000;

/**
 * Milestone 84 (docs/adr/0018 §6): whether this visitor may use the site, from
 * `GET /api/v1/access/status`. If the check itself fails the site is treated as open — the API
 * still refuses anything a visitor may not see, so failing open here only means a less helpful
 * page, never a leak.
 */
export function useAccess(): { access: AccessState; refresh: () => Promise<void> } {
  const [access, setAccess] = useState<AccessState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/access/status");
      if (!response.ok) throw new Error(String(response.status));
      setAccess({ status: "ready", access: await readApiJson<AccessStatus>(response) });
    } catch {
      setAccess({
        status: "ready",
        access: {
          mode: "open",
          access: "none",
          allowed: true,
          expiresAt: null,
          scope: null,
          maps: [],
        },
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { access, refresh };
}
