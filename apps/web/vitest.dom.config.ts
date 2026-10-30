import { defineConfig } from "vitest/config";
import { DOM_TS_TESTS, sharedConfig } from "./vitest.shared.js";

/** Web tests that need a DOM, in jsdom — see vitest.shared.ts. */
export default defineConfig({
  ...sharedConfig,
  test: {
    name: "@railway/web (dom)",
    environment: "jsdom",
    include: ["src/**/*.test.tsx", ...DOM_TS_TESTS],
    setupFiles: ["./src/setupTests.ts"],
    // Rendering tests (the editor's Konva canvas, large maps) take seconds on a busy machine;
    // the 5 s default made them fail when nothing was wrong.
    testTimeout: 20_000,
  },
});
