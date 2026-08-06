import { loadConfig } from "./config.js";
import { parseCommand } from "./dispatch.js";
import { runCheckConnectivity } from "./commands/checkConnectivity.js";
import { runEnsureArchiveBucket } from "./commands/ensureArchiveBucket.js";
import { runMigrate } from "./commands/migrate.js";
import { runEnsurePartitions } from "./commands/ensurePartitions.js";
import { runReconcileArchive } from "./commands/reconcileArchive.js";
import { runReplayFixtures } from "./commands/replayFixtures.js";
import { runProjectTdCommand } from "./commands/projectTd.js";
import { runPublishMap } from "./commands/publishMap.js";
import { runBackfillMapBindings } from "./commands/backfillMapBindings.js";
import { runProjectMapDeltasCommand } from "./commands/projectMapDeltas.js";
import { runIngestTd } from "./commands/ingestTd.js";
import { runIngestVstp } from "./commands/ingestVstp.js";
import { runProjectVstpCommand } from "./commands/projectVstp.js";
import { runImportScheduleCommand } from "./commands/importSchedule.js";
import { runDownloadSchedule } from "./commands/downloadSchedule.js";
import { runImportCorpusCommand } from "./commands/importCorpus.js";
import { runDownloadCorpus } from "./commands/downloadCorpus.js";
import { runImportSmartCommand } from "./commands/importSmart.js";
import { runDownloadSmart } from "./commands/downloadSmart.js";
import { runIngestTrust } from "./commands/ingestTrust.js";
import { runProjectTrustCommand } from "./commands/projectTrust.js";
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
    case "project-td":
      return runProjectTdCommand(config, argvRest);
    case "publish-map":
      return runPublishMap(config, argvRest);
    case "backfill-map-bindings":
      return runBackfillMapBindings(config);
    case "project-map-deltas":
      return runProjectMapDeltasCommand(config);
    case "project-vstp":
      return runProjectVstpCommand(config, argvRest);
    case "import-schedule":
      return runImportScheduleCommand(config, argvRest);
    case "download-schedule":
      return runDownloadSchedule(config);
    case "import-corpus":
      return runImportCorpusCommand(config, argvRest);
    case "download-corpus":
      return runDownloadCorpus(config);
    case "import-smart":
      return runImportSmartCommand(config, argvRest);
    case "download-smart":
      return runDownloadSmart(config);
    case "project-trust":
      return runProjectTrustCommand(config, argvRest);
    case "ingest-td":
      await runIngestTd(config);
      return;
    case "ingest-vstp":
      await runIngestVstp(config);
      return;
    case "ingest-trust":
      await runIngestTrust(config);
      return;
    case "serve":
      await runServe(config);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
