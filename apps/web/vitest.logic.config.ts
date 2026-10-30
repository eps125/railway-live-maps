import { defineConfig } from "vitest/config";
import { DOM_TS_TESTS, sharedConfig } from "./vitest.shared.js";

/** Logic-only web tests, in plain Node — see vitest.shared.ts. */
export default defineConfig({
  ...sharedConfig,
  test: {
    name: "@railway/web (logic)",
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: DOM_TS_TESTS,
  },
});
