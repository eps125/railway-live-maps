/** Milestone 84: small formatting helpers for the Admin › Access codes page. */

const UNITS: [number, string][] = [
  [24 * 60 * 60, "day"],
  [60 * 60, "hour"],
  [60, "minute"],
];

/** `3600` → "1 hour", `90000` → "1 day 1 hour", `5400` → "1 hour 30 minutes". */
export function formatDuration(seconds: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(seconds));
  for (const [size, name] of UNITS) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      rest -= count * size;
    }
  }
  return parts.length > 0 ? parts.slice(0, 2).join(" ") : "under a minute";
}

/** The presets offered when creating a code; anything else is "custom". */
export const ACCESS_PERIOD_PRESETS: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "4 hours", seconds: 4 * 60 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
];

/** An ISO timestamp as the value of a `datetime-local` input, in the browser's time zone. */
export function toDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** A `datetime-local` value (browser time zone) as an ISO timestamp, or null if empty/invalid. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const londonDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatLondon(iso: string | null): string {
  return iso ? londonDateTime.format(new Date(iso)) : "—";
}

export const FLAG_TEXT: Record<string, string> = {
  many_ips: "Used from 3 or more addresses",
  simultaneous_ips: "Used from 2 addresses in the same hour",
  many_networks: "Uses came from 3 or more different networks",
};
