import { loadConfig } from "./config.js";
import { parseCommand } from "./dispatch.js";
import { runCheckConnectivity } from "./commands/checkConnectivity.js";
import { runEnsureArchiveBucket } from "./commands/ensureArchiveBucket.js";
import { runMigrate } from "./commands/migrate.js";
import { runEnsurePartitions } from "./commands/ensurePartitions.js";
import { runReconcileArchive } from "./commands/reconcileArchive.js";
import { runReplayFixtures } from "./commands/replayFixtures.js";
import { runIngestTd } from "./commands/ingestTd.js";
import { runServe } from "./serve.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = parseCommand(argv);
  const config = loadConfig();
  const argvRest = argv.slice(1);

  switch (command) {
    case "check-connectivity":
      return runCheckConnectivity(config);
    case "ensure-archive-bucket":
      return runEnsureArchiveBucket(config);
    case "migrate":
      return runMigrate(config);
    case "ensure-partitions":
      return runEnsurePartitions(config);
    case "reconcile-archive":
      return runReconcileArchive(config, argvRest);
    case "replay-fixtures":
      return runReplayFixtures(config, argvRest);
    case "ingest-td":
      await runIngestTd(config);
      return;
    case "serve":
      await runServe(config);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
