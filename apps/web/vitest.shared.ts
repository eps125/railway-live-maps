import react from "@vitejs/plugin-react";
import type { UserConfig } from "vitest/config";

/**
 * 2026-10-30 (owner: the suite had got slow): the web tests run as two projects — `logic` (the
 * `.ts` tests, plain Node, no jsdom) and `dom` (the `.tsx` tests, jsdom). Each is its own config
 * file so the repository root's `vitest.config.ts` can list both: Vitest doesn't pick up projects
 * nested inside a project's config, which is why they aren't inline in `vitest.config.ts`.
 */
export const sharedConfig: UserConfig = {
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
};

/** `.ts` test files that need a DOM (history, rendering helpers): they run in the `dom` project. */
export const DOM_TS_TESTS = ["src/useRoute.test.ts"];
