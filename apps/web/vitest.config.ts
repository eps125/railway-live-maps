import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/setupTests.ts"],
  },
});
