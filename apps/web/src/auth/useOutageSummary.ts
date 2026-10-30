import { useEffect, useState } from "react";

export interface OutageSummary {
  /** Outages recorded since this user last opened the Data outages page. */
  unseen: number;
  /** TD has been silent longer than the gap tolerance right now. */
  ongoing: boolean;
}

/** Fired by the Data outages page once it has marked what it shows as seen, so the pill clears
 * straight away rather than at the next poll. */
export const OUTAGES_SEEN_EVENT = "rlm:outages-seen";

const POLL_MS = 60_000;

/** The number the pill shows: unseen outages, plus one for an outage happening now. */
export function outagePillCount(summary: OutageSummary | null): number {
  if (!summary) return 0;
  return summary.unseen + (summary.ongoing ? 1 : 0);
}

/**
 * 2026-10-30 (owner request): the unseen-outage count behind the pill on the Admin link — polled
 * once a minute while `enabled` (the viewer may see outage details), so an admin sees at a glance,
 * as soon as they log in, that the feed has had an outage.
 */
export function useOutageSummary(enabled: boolean): OutageSummary | null {
  const [summary, setSummary] = useState<OutageSummary | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/v1/admin/outages/summary");
        if (!response.ok) return;
        const body = (await response.json()) as OutageSummary;
        if (!cancelled) setSummary({ unseen: body.unseen, ongoing: body.ongoing });
      } catch {
        // A failed poll leaves the last count showing; the next one retries.
      }
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onSeen = () => void load();
    window.addEventListener(OUTAGES_SEEN_EVENT, onSeen);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(OUTAGES_SEEN_EVENT, onSeen);
    };
  }, [enabled]);

  return summary;
}
