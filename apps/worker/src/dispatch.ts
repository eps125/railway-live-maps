export const ONE_SHOT_COMMAND_NAMES = [
  "check-connectivity",
  "ensure-archive-bucket",
  "migrate",
  "ensure-partitions",
  "reconcile-archive",
  "replay-fixtures",
] as const;
export type OneShotCommandName = (typeof ONE_SHOT_COMMAND_NAMES)[number];

/** Long-running worker roles. "serve" is the default (no argv) idle daemon; "ingest-td"
 * is the live TD feed connector — refuses to start unless TD_LIVE_ENABLED=true. */
export const LONG_RUNNING_ROLE_NAMES = ["serve", "ingest-td"] as const;
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
