import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** `.ts` test files that need a DOM (history, rendering helpers). */
const DOM_TS_TESTS = ["src/useRoute.test.ts"];

export default defineConfig({
  plugins: [react()],
  // Konva ships separate browser/Node builds selected via package.json export conditions;
  // Vitest resolves deps in Node ("ssr") mode by default even under the jsdom test
  // environment, which would otherwise pick Konva's Node build (which `require`s the native
  // `canvas` package) instead of its browser build. Force the browser build so
  // `vitest-canvas-mock`'s jsdom canvas-context mocking is what Konva actually talks to.
  resolve: {
    alias: [
      // RegExp exact-match only. A plain string key would prefix-replace, which would also
      // rewrite react-konva's own deep imports like `konva/lib/Core.js` into the broken path
      // `konva/lib/index.js/lib/Core.js`.
      { find: /^konva$/, replacement: "konva/lib/index.js" },
    ],
  },
  // 2026-10-30 (owner: the suite had got slow): two projects. Most of a run's time was each file
  // loading jsdom, including the logic-only `.ts` files that never touch a DOM — those now run in
  // plain Node. A `.ts` test that does need a DOM goes in DOM_TS_TESTS.
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "logic",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: DOM_TS_TESTS,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", ...DOM_TS_TESTS],
          setupFiles: ["./src/setupTests.ts"],
          // Rendering tests (the editor's Konva canvas, large maps) take seconds on a busy
          // machine; the 5 s default made them fail when nothing was wrong.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
