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
  "import-corpus",
  "download-corpus",
  "import-smart",
  "download-smart",
  "refresh-reference-data",
  "backfill-td-area-summary",
  "prune-partitions",
  "snapshot-maps",
  "repair-open-occupancies",
] as const;
export type OneShotCommandName = (typeof ONE_SHOT_COMMAND_NAMES)[number];

/** Long-running worker roles. "serve" is the default (no argv) idle daemon; "ingest-td" is the
 * live TD feed connector — refuses to start unless `TD_LIVE_ENABLED` is true.
 * "schedule-reference-refresh" runs the `refresh-reference-data` one-shot (CORPUS/SMART) once a
 * day at a fixed Europe/London time — refuses to start unless SCHEDULE_DOWNLOAD_ENABLED is true.
 * "project-td-daemon" (2026-09 live-path hardening) replaces the `projector-td`/`map-deltas`
 * Portainer services' per-cycle `node ...; sleep 1` shell loops with one persistent process —
 * see runDaemonLoop's doc comment. "project-td-live-daemon" (ADR 0003) is the dedicated hot
 * path — `berth_current_state` + Redis delta publish only, on a 100ms tick.
 * "snapshot-maps-daemon" (Milestone 10) writes a periodic `map_state_snapshot` per effective
 * published map version. "ingest-garner" (ADR 0002) mirrors TRUST / VSTP-schedule /
 * CORPUS / SMART from the operator's openrail-eps MariaDB — RLM no longer subscribes to Network
 * Rail for those feeds, so the `ingest-vstp` / `ingest-trust` roles and the `project-vstp` /
 * `project-trust` / `import-schedule` / `download-schedule` commands were removed. (The
 * `project-resolver` daemon/commands went the same way, with the rest of the berth-run
 * resolver.) */
export const LONG_RUNNING_ROLE_NAMES = [
  "serve",
  "ingest-td",
  "schedule-reference-refresh",
  "project-td-daemon",
  "project-td-live-daemon",
  "ingest-garner",
  "snapshot-maps-daemon",
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
