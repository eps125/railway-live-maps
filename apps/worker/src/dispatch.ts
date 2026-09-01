export const ONE_SHOT_COMMAND_NAMES = [
  "check-connectivity",
  "ensure-archive-bucket",
  "migrate",
  "ensure-partitions",
  "reconcile-archive",
  "replay-fixtures",
  "project-td",
  "publish-map",
  "backfill-map-bindings",
  "project-map-deltas",
  "project-vstp",
  "reparse-vstp-archive",
  "import-schedule",
  "download-schedule",
  "import-corpus",
  "download-corpus",
  "import-smart",
  "download-smart",
  "refresh-reference-data",
  "project-trust",
  "backfill-td-area-summary",
  "prune-partitions",
] as const;
export type OneShotCommandName = (typeof ONE_SHOT_COMMAND_NAMES)[number];

/** Long-running worker roles. "serve" is the default (no argv) idle daemon; "ingest-td"/
 * "ingest-vstp"/"ingest-trust" are the live feed connectors — each refuses to start unless its
 * own `*_LIVE_ENABLED` flag is true. "schedule-reference-refresh" runs the same work as the
 * `refresh-reference-data` one-shot command, but once a day at a fixed Europe/London time rather
 * than on demand — refuses to start unless SCHEDULE_DOWNLOAD_ENABLED is true.
 * "project-td-daemon" (2026-09 live-path hardening) replaces the `projector-td`/`map-deltas`
 * Portainer services' per-cycle `node ...; sleep 1` shell loops with one persistent process —
 * see runDaemonLoop's doc comment. (The `project-resolver` daemon/commands were removed by
 * ADR 0002 along with the rest of the berth-run resolver.) */
export const LONG_RUNNING_ROLE_NAMES = [
  "serve",
  "ingest-td",
  "ingest-vstp",
  "ingest-trust",
  "schedule-reference-refresh",
  "project-td-daemon",
  "ingest-garner",
] as const;
export type LongRunningRoleName = (typeof LONG_RUNNING_ROLE_NAMES)[number];

export type CommandName = OneShotCommandName | LongRunningRoleName;

export class UnknownCommandError extends Error {
  constructor(given: string) {
    super(
      `Unknown worker command "${given}". Expected one of: ${[...ONE_SHOT_COMMAND_NAMES, ...LONG_RUNNING_ROLE_NAMES].join(", ")}`,
    );
    this.name = "UnknownCommandError";
  }
}

/**
 * Parses the worker's role/command from argv (e.g. `node dist/index.js migrate`).
 * No argv selects the default long-running "serve" role (see serve.ts).
 */
export function parseCommand(argv: string[]): CommandName {
  const given = argv[0];
  if (given === undefined) {
    return "serve";
  }
  if ((ONE_SHOT_COMMAND_NAMES as readonly string[]).includes(given)) {
    return given as OneShotCommandName;
  }
  if ((LONG_RUNNING_ROLE_NAMES as readonly string[]).includes(given)) {
    return given as LongRunningRoleName;
  }
  throw new UnknownCommandError(given);
}
