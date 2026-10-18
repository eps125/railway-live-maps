/**
 * Milestone 94: the live socket patches its state records (berths, signals, …) in place once per
 * frame and logs which entries each patch changed, instead of copying the whole record for every
 * message. Copying a 6,000-berth record costs about 10 ms in V8 — per message, before batching —
 * which on a large map was most of the cost of a live update. Readers find what changed since
 * the version they last saw with `changesSince`; a new record (a snapshot, or playback's own
 * records) has version 0 and is compared in full.
 */
interface ChangeLog {
  version: number;
  entries: Array<{ version: number; ids: readonly string[] }>;
}

const logs = new WeakMap<object, ChangeLog>();
/** Patches remembered per record; a reader further behind than this compares in full. */
const MAX_ENTRIES = 256;

export function patchInPlace<T>(record: Record<string, T>, patch: Record<string, T>): void {
  Object.assign(record, patch);
  let log = logs.get(record);
  if (!log) logs.set(record, (log = { version: 0, entries: [] }));
  log.version += 1;
  log.entries.push({ version: log.version, ids: Object.keys(patch) });
  if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES);
}

/** How many patches `record` has had. */
export function recordVersion(record: object): number {
  return logs.get(record)?.version ?? 0;
}

/** The entries patched since `version`, or `null` when that is no longer known. May list an
 * entry more than once, or one whose value ended up unchanged. */
export function changesSince(record: object, version: number): readonly string[] | null {
  const log = logs.get(record);
  if (!log) return version === 0 ? [] : null;
  if (version === log.version) return [];
  const first = log.entries[0];
  if (!first || first.version > version + 1) return null;
  return log.entries.filter((entry) => entry.version > version).flatMap((entry) => entry.ids);
}
