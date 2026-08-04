import { stat } from "node:fs/promises";
import { HEARTBEAT_FILE } from "./serve.js";

const MAX_AGE_MS = 90_000;

stat(HEARTBEAT_FILE)
  .then((stats) => {
    const age = Date.now() - stats.mtime.getTime();
    process.exit(age <= MAX_AGE_MS ? 0 : 1);
  })
  .catch(() => {
    process.exit(1);
  });
