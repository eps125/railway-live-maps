import type { Pool } from "pg";
import {
  findActiveGrant,
  getSiteSettings,
  pruneGrantActivity,
  recordGrantActivity,
  type ActiveGrant,
  type GrantActivityEntry,
  type SiteAccessMode,
} from "@railway/database";

/** The browser cookie holding a grant's opaque token (Milestone 84). */
export const ACCESS_COOKIE_NAME = "rlm_access";
/** The cookie itself lives long; the grant's own expiry (which an admin may change) decides. */
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** How long the site mode and a grant lookup are reused before re-reading Postgres. Revoking
 * through the API forgets the cached grants at once; this only bounds other paths. */
const MODE_CACHE_MS = 5_000;
const GRANT_CACHE_MS = 15_000;
const GRANT_CACHE_LIMIT = 5_000;
const ACTIVITY_FLUSH_MS = 30_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
/** Owner decision (docs/adr/0018): activity is kept for 90 days. */
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface SiteAccess {
  siteMode(): Promise<SiteAccessMode>;
  /** The valid grant behind a token, or null. `fresh` skips the cache. */
  grantForToken(token: string | undefined, fresh?: boolean): Promise<ActiveGrant | null>;
  /** Counts one request by a grant (written in batches). */
  noteActivity(grantId: string, ip: string, userAgent: string | null): void;
  /** Forget cached state after an admin change. */
  invalidate(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function hourOf(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000);
}

/**
 * Milestone 84 (docs/adr/0018 §6): the API process's view of site access — the current mode,
 * which grant a cookie belongs to, and per-grant request counts. Counts are summed in memory and
 * written every 30 s, so a viewer polling the map costs one row update per half minute, not one
 * per request. Old activity is pruned hourly.
 */
export function createSiteAccess(pool: Pool, options: { timers?: boolean } = {}): SiteAccess {
  let mode: { value: SiteAccessMode; at: number } | null = null;
  const grants = new Map<string, { grant: ActiveGrant | null; at: number }>();
  const pending = new Map<string, GrantActivityEntry>();
  let flushing: Promise<void> | null = null;

  async function flush(): Promise<void> {
    if (flushing) return flushing;
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    flushing = recordGrantActivity(pool, entries)
      .catch((error: unknown) => {
        // Losing a batch of counts is acceptable; never let it break a request.
        console.error("siteAccess: activity flush failed", error);
      })
      .finally(() => {
        flushing = null;
      });
    return flushing;
  }

  const timers: NodeJS.Timeout[] = [];
  if (options.timers !== false) {
    timers.push(setInterval(() => void flush(), ACTIVITY_FLUSH_MS));
    timers.push(
      setInterval(() => {
        pruneGrantActivity(pool, new Date(Date.now() - ACTIVITY_RETENTION_MS)).catch(
          (error: unknown) => console.error("siteAccess: activity prune failed", error),
        );
      }, PRUNE_EVERY_MS),
    );
    for (const timer of timers) timer.unref();
  }

  return {
    async siteMode() {
      const now = Date.now();
      if (mode && now - mode.at < MODE_CACHE_MS) return mode.value;
      const settings = await getSiteSettings(pool);
      mode = { value: settings.site_access_mode, at: now };
      return mode.value;
    },

    async grantForToken(token, fresh = false) {
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
      const now = Date.now();
      const cached = grants.get(token);
      if (!fresh && cached && now - cached.at < GRANT_CACHE_MS) {
        // A cached grant can still expire in the meantime.
        if (cached.grant && cached.grant.expiresAt.getTime() <= now) return null;
        return cached.grant;
      }
      const grant = await findActiveGrant(pool, token, new Date(now));
      grants.delete(token);
      grants.set(token, { grant, at: now });
      while (grants.size > GRANT_CACHE_LIMIT) grants.delete(grants.keys().next().value!);
      return grant;
    },

    noteActivity(grantId, ip, userAgent) {
      const now = new Date();
      const hour = hourOf(now);
      const key = `${grantId}|${hour.getTime()}|${ip}`;
      const entry = pending.get(key);
      if (entry) {
        entry.requests += 1;
        entry.lastSeenAt = now;
      } else {
        pending.set(key, { grantId, hour, ip, userAgent, requests: 1, lastSeenAt: now });
      }
    },

    invalidate() {
      mode = null;
      grants.clear();
    },

    flush,

    async close() {
      for (const timer of timers) clearInterval(timer);
      await flush();
    },
  };
}
